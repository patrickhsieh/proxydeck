import { useState, useEffect, useRef } from 'preact/hooks';
import browser from 'webextension-polyfill';
import { MESSAGE_ACTIONS } from '../../common/constants';
import TrafficCharts from './TrafficCharts';
import TimeWindowSelector from './TimeWindowSelector';
import { Card, CardContent } from '../../components/ui/card';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '../../components/ui/tooltip';
import browserCapabilities from '../../utils/feature-detection';

const TrafficDashboard = () => {
  const [selectedWindow, setSelectedWindow] = useState('1min');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const [trafficData, setTrafficData] = useState({
    data: [],
    stats: {
      download: { current: 0, peak: 0, total: 0, average: 0 },
      upload: { current: 0, peak: 0, total: 0, average: 0 },
      perProxy: {}
    },
    meta: {
      windowSize: '1min',
      sampleInterval: 1000,
      pointCount: 0
    },
    lastUpdate: Date.now()
  });
  const [proxies, setProxies] = useState([]);
  const selectedWindowRef = useRef('1min'); // Track selected window to avoid circular updates
  const initializedRef = useRef(false); // Prevent duplicate initialization calls in StrictMode
  const fetchedWindowsRef = useRef(new Set()); // Track which windows have been fetched
  // Store all window data in Recharts format
  const dataBufferRef = useRef({
    '1min': { 
      data: [], 
      stats: {
        download: { current: 0, peak: 0, total: 0, average: 0 },
        upload: { current: 0, peak: 0, total: 0, average: 0 },
        perProxy: {}
      },
      meta: { windowSize: '1min' }
    },
    '5min': { 
      data: [],
      stats: {
        download: { current: 0, peak: 0, total: 0, average: 0 },
        upload: { current: 0, peak: 0, total: 0, average: 0 },
        perProxy: {}
      },
      meta: { windowSize: '5min' }
    },
    '10min': { 
      data: [],
      stats: {
        download: { current: 0, peak: 0, total: 0, average: 0 },
        upload: { current: 0, peak: 0, total: 0, average: 0 },
        perProxy: {}
      },
      meta: { windowSize: '10min' }
    }
  });

  const fetchProxies = async () => {
    try {
      // Get complete traffic sources from TrafficMonitor (includes configured proxies + special traffic)
      const allTrafficSources = await browser.runtime.sendMessage({
        action: MESSAGE_ACTIONS.GET_TRAFFIC_SOURCES
      });
      
      setProxies(allTrafficSources || []);
    } catch (error) {
      console.error('Failed to fetch traffic sources:', error);
      // Fallback to just configured proxies if message fails
      try {
        const { config = { proxies: [] } } = await browser.storage.local.get('config');
        setProxies(config.proxies || []);
      } catch (fallbackError) {
        console.error('Failed to fetch fallback proxies:', fallbackError);
      }
    }
  };

  const fetchTrafficData = async (windowSize, forceRefresh = false) => {
    // Only prevent duplicate fetches for 1min view to reduce load
    // Always allow fetching for aggregated views to ensure fresh data
    if (!forceRefresh && windowSize === '1min' && fetchedWindowsRef.current.has(windowSize)) {
      return;
    }
    
    if (windowSize === '1min') {
      fetchedWindowsRef.current.add(windowSize);
    }
    
    try {
      setLoading(true);
      setError(null);
      
      
      const response = await browser.runtime.sendMessage({
        action: MESSAGE_ACTIONS.GET_TRAFFIC_DATA,
        windowSize
      });


      if (response.error) {
        throw new Error(response.error);
      }

      // Store the new Recharts data format
      const { data, stats, meta } = response;
      
      // Update the buffer for the selected window
      dataBufferRef.current[windowSize] = {
        data: data || [],
        stats,
        meta
      };

      // Update UI state with the new data
      setTrafficData({
        data: data || [],
        stats,
        meta,
        lastUpdate: Date.now()
      });
    } catch (error) {
      console.error('Failed to fetch traffic data:', error);
      setError(error.message);
    } finally {
      setLoading(false);
    }
  };

  const mergeTrafficUpdate = (updateData) => {
    try {
      if (!updateData.updates) {
        console.error('[TrafficDashboard] Invalid update data structure');
        return;
      }
      
      // Process updates for each time window
      const windows = Object.keys(updateData.updates);
      
      // Update all window buffers with new data
      windows.forEach(windowSize => {
        const windowUpdate = updateData.updates[windowSize];
        const buffer = dataBufferRef.current[windowSize];
        
        if (!buffer || !windowUpdate) {
            return;
        }
        
        // Merge new data with existing data
        if (windowUpdate.data && Array.isArray(windowUpdate.data)) {
          // Get existing timestamps for O(1) lookup
          const existingTimestamps = new Set(
            buffer.data.map(point => point.timestamp)
          );
          
          // Add new points efficiently
          for (const point of windowUpdate.data) {
            if (!existingTimestamps.has(point.timestamp)) {
              buffer.data.push(point);
              existingTimestamps.add(point.timestamp);
            }
          }
          
          // Sort by timestamp
          buffer.data.sort((a, b) => a.timestamp - b.timestamp);
          
          // Trim to 60 points maximum
          if (buffer.data.length > 60) {
            buffer.data = buffer.data.slice(-60);
          }
        }
        
        // Update stats
        if (windowUpdate.stats) {
          // Merge stats with existing stats
          buffer.stats = {
            ...buffer.stats,
            ...windowUpdate.stats
          };
        }
        
        // Update metadata
        if (windowUpdate.meta) {
          buffer.meta = {
            ...buffer.meta,
            ...windowUpdate.meta,
            lastUpdate: Date.now()
          };
        }
      });
      
      // Only update UI if we're currently viewing a window that received updates
      const currentSelected = selectedWindowRef.current;
      if (windows.includes(currentSelected)) {
        const selectedBuffer = dataBufferRef.current[currentSelected];
        if (selectedBuffer) {
          setTrafficData({
            data: [...selectedBuffer.data],
            stats: {...selectedBuffer.stats},
            meta: {...selectedBuffer.meta},
            lastUpdate: Date.now()
          });
        }
      }
    } catch (error) {
      console.error('[TrafficDashboard] Error in mergeTrafficUpdate:', error);
    }
  };

  // Initial load effect - only runs once
  useEffect(() => {
    if (initializedRef.current) {
      return; // Prevent duplicate calls in strict mode
    }
    initializedRef.current = true;

    fetchProxies();
    fetchTrafficData(selectedWindow);

    const messageListener = (message) => {
      if (message.action === MESSAGE_ACTIONS.TRAFFIC_UPDATE) {
        mergeTrafficUpdate(message);
      }
      return false;
    };

    browser.runtime.onMessage.addListener(messageListener);

    return () => {
      browser.runtime.onMessage.removeListener(messageListener);
    };
  }, []); // Remove selectedWindow dependency to prevent full refresh

  // Handle window changes separately - only update display data
  useEffect(() => {
    // Skip on initial mount - let the first useEffect handle initial data fetch
    if (!initializedRef.current) {
      return;
    }
    
    selectedWindowRef.current = selectedWindow; // Update ref
    const selectedBuffer = dataBufferRef.current[selectedWindow];
    
    // For aggregated views (5min, 10min), always fetch fresh data to ensure we have the latest
    // For 1min view, use cache if available to reduce load
    if (selectedWindow !== '1min') {
      fetchTrafficData(selectedWindow, true);
    } else if (selectedBuffer && selectedBuffer.data.length > 0) {
      // Use cached data if available for 1min view
      setTrafficData({
        data: [...selectedBuffer.data],
        stats: {...selectedBuffer.stats},
        meta: {...selectedBuffer.meta},
        lastUpdate: Date.now()
      });
    } else {
      // Fetch if no cached data
      fetchTrafficData(selectedWindow);
    }
  }, [selectedWindow]);

  const handleWindowChange = (newWindow) => {
    if (newWindow === selectedWindow) return;
    
    // Simply update the selected window - useEffect will handle the data switching
    setSelectedWindow(newWindow);
  };

  if (loading) {
    return (
      <div className="mt-4">
      <Card>
        <CardContent className="text-center py-8">
          <p className="text-muted-foreground">Loading traffic data...</p>
        </CardContent>
      </Card>
    </div>
    );
  }

  if (error) {
    return (
      <div className="mt-4">
        <Card>
          <CardContent className="text-center py-8">
            <p className="text-destructive">Error: {error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Check if we have per-proxy data by looking at the data points
  const hasPerProxyData = trafficData.data.length > 0 && 
    Object.keys(trafficData.data[0]).some(key => 
      key.startsWith('download_') && key !== 'download_total'
    );
  
  // Extract proxy IDs from the data if we have per-proxy data
  // This ensures we can show stacked charts even if the proxies list is empty
  if (hasPerProxyData && (!proxies || proxies.length === 0) && trafficData.data.length > 0) {
    const proxyIds = new Set();
    
    // Get proxy IDs from the first data point
    const firstDataPoint = trafficData.data[0];
    Object.keys(firstDataPoint).forEach(key => {
      if (key.startsWith('download_') && key !== 'download_total') {
        const proxyId = key.replace('download_', '');
        proxyIds.add(proxyId);
      }
    });
    
    if (proxyIds.size > 0) {
      // Request complete traffic sources from TrafficMonitor
      fetchProxies();
    }
  }
  
  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={100}>
      <div>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            Traffic Monitor
            {browserCapabilities.browser.isChrome && (
              <Tooltip delayDuration={0} open={isTooltipOpen} onOpenChange={setIsTooltipOpen}>
                <TooltipTrigger asChild>
                  <span className="text-xs text-muted-foreground/70 font-normal cursor-help border-b border-dashed border-muted-foreground/30 hover:border-muted-foreground/60 transition-colors">
                    (estimated)
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs p-3">
                  <div className="flex items-start gap-2">
                    <span className="text-amber-500">⚠️</span>
                    <div className="space-y-1">
                      <p className="font-medium text-sm">Traffic estimates only</p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Chrome extensions can't measure exact traffic for streaming sites (YouTube, Netflix, etc.) due to missing Content-Length headers.
                      </p>
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
          </h2>
        <TimeWindowSelector
          selected={selectedWindow}
          onChange={handleWindowChange}
        />
      </div>
      
      <p className="text-sm text-muted-foreground mb-4">
        Monitor real-time traffic volume across all connections or per proxy.
      </p>

      <div className="space-y-4">
        <TrafficCharts
          type="download"
          data={trafficData.data}
          proxies={proxies}
          hasPerProxyData={hasPerProxyData}
          windowSize={selectedWindow}
          lastUpdate={trafficData.lastUpdate}
          stats={trafficData.stats}
        />
        <TrafficCharts
          type="upload"
          data={trafficData.data}
          proxies={proxies}
          hasPerProxyData={hasPerProxyData}
          windowSize={selectedWindow}
          lastUpdate={trafficData.lastUpdate}
          stats={trafficData.stats}
        />
      </div>
      </div>
    </TooltipProvider>
  );
};

export default TrafficDashboard;
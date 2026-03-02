import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries } from 'lightweight-charts';
import PropTypes from 'prop-types';

export function SentimentCandleChart({ data }) {
  const chartContainerRef = useRef();
  const chartRef = useRef();
  const candlestickSeriesRef = useRef();
  const tooltipRef = useRef();

  useEffect(() => {
    if (!chartContainerRef.current || data.length === 0) return;

    const container = chartContainerRef.current;

    // Create chart
    const chart = createChart(container, {
      width: chartContainerRef.current.clientWidth,
      height: 400,
      layout: {
        background: { color: '#ffffff' },
        textColor: '#2D2D31',
        fontSize: 12,
      },
      localization: {
        timeFormatter: (time) => {
          const date = new Date(time * 1000);
          const day = date.getUTCDate();
          const months = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
          const month = months[date.getUTCMonth()];
          const year = date.getUTCFullYear();
          return `${day} ${month} ${year}`;
        },
      },
      grid: {
        vertLines: { color: '#EDEDF0' },
        horzLines: { color: '#EDEDF0' },
      },
      timeScale: {
        timeVisible: false,
        borderColor: '#EDEDF0',
        barSpacing: 16,
        minBarSpacing: 12,
        ticksVisible: true,
        tickMarkMaxCharacterLength: 2,
        tickMarkFormatter: (time) => {
          const date = new Date(time * 1000);
          const day = date.getUTCDate();
          return `${day}`;
        },
      },
      rightPriceScale: {
        borderColor: '#EDEDF0',
        scaleMargins: {
          top: 0.1,
          bottom: 0.1,
        },
        visible: true,
      },
      crosshair: {
        mode: 1, // Normal crosshair mode
        vertLine: {
          color: '#97979B',
          width: 1,
          style: 3, // Dashed
          labelBackgroundColor: '#2D2D31',
        },
        horzLine: {
          color: '#97979B',
          width: 1,
          style: 3,
          labelBackgroundColor: '#2D2D31',
        },
      },
    });

    chartRef.current = chart;

    // Add candlestick series (v5 API)
    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#228B22',
      downColor: '#b91c1c',
      borderVisible: true,
      borderUpColor: '#228B22',
      borderDownColor: '#b91c1c',
      wickUpColor: '#228B22',
      wickDownColor: '#b91c1c',
    });

    candlestickSeriesRef.current = candlestickSeries;

    // Transform data to candlestick format
    const candleData = transformToCandleData(data);
    candlestickSeries.setData(candleData);

    // Create tooltip element
    const toolTip = document.createElement('div');
    toolTip.style.cssText = `
      position: absolute;
      display: none;
      padding: 8px 12px;
      background: white;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      font-size: 14px;
      pointer-events: none;
      z-index: 1000;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;
    container.appendChild(toolTip);
    tooltipRef.current = toolTip;

    // Fit content and ensure all data is visible
    chart.timeScale().fitContent();
    
    // Set visible range to show all data
    if (candleData.length > 0) {
      chart.timeScale().setVisibleRange({
        from: candleData[0].time,
        to: candleData[candleData.length - 1].time,
      });
    }

    // Add tooltip tracking
    chart.subscribeCrosshairMove((param) => {
      if (
        !param.time ||
        !param.point ||
        param.point.x < 0 ||
        param.point.x > container.clientWidth ||
        param.point.y < 0 ||
        param.point.y > container.clientHeight ||
        !param.seriesData.get(candlestickSeries)
      ) {
        toolTip.style.display = 'none';
        return;
      }

      const candleData = param.seriesData.get(candlestickSeries);
      const date = new Date(param.time * 1000);
      const day = date.getUTCDate();
      const months = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
      const month = months[date.getUTCMonth()];
      const year = date.getUTCFullYear();
      
      toolTip.style.display = 'block';
      toolTip.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 4px;">${day} ${month} ${year}</div>
        <div>Otwarcie: <span style="font-weight: 500;">${candleData.open.toFixed(2)}</span></div>
        <div>Maks: <span style="font-weight: 500;">${candleData.high.toFixed(2)}</span></div>
        <div>Min: <span style="font-weight: 500;">${candleData.low.toFixed(2)}</span></div>
        <div>Zamknięcie: <span style="font-weight: 500;">${candleData.close.toFixed(2)}</span></div>
      `;

      const y = param.point.y;
      let left = param.point.x + 20;
      let top = y;

      if (left > container.clientWidth - toolTip.offsetWidth - 10) {
        left = param.point.x - toolTip.offsetWidth - 20;
      }

      top = Math.min(top, container.clientHeight - toolTip.offsetHeight - 10);
      top = Math.max(10, top);

      toolTip.style.left = left + 'px';
      toolTip.style.top = top + 'px';
    });

    // Handle resize
    const handleResize = () => {
      if (container && chartRef.current) {
        chartRef.current.applyOptions({
          width: container.clientWidth,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (tooltipRef.current && container) {
        container.removeChild(tooltipRef.current);
      }
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [data]);

  return <div ref={chartContainerRef} className="relative w-full" />;
}

// Transform sentiment data into candlestick format
// We'll group multiple sentiment readings per day into OHLC
function transformToCandleData(sentimentData) {
  // Group by date
  const groupedByDate = {};
  
  sentimentData.forEach(item => {
    // Skip items with missing sentiment data
    if (!item.sentiment || item.sentiment === null || item.sentiment === undefined) {
      return;
    }
    
    const date = item.date;
    const timestamp = item.timestamp;
    const sentiment = item.sentiment;
    
    if (!groupedByDate[date]) {
      groupedByDate[date] = {
        date,
        timestamp,
        sentiments: [],
        timestamps: [],
      };
    }
    groupedByDate[date].sentiments.push(sentiment);
    groupedByDate[date].timestamps.push(timestamp);
  });

  // Convert to candlestick format
  const candleData = Object.values(groupedByDate)
    .filter(group => group.sentiments.length > 0) // Only include dates with data
    .map(group => {
      // Sort sentiments by timestamp to ensure correct OHLC order
      const combined = group.sentiments.map((sentiment, i) => ({
        sentiment,
        timestamp: group.timestamps[i]
      })).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      
      const sentiments = combined.map(item => item.sentiment);
      const open = sentiments[0];
      const close = sentiments[sentiments.length - 1];
      const high = Math.max(...sentiments);
      const low = Math.min(...sentiments);
      
      // Convert date string to timestamp (lightweight-charts expects Unix timestamp in seconds)
      // Use UTC to match how the dates were formatted
      const [day, month] = group.date.split('.');
      const year = new Date(group.timestamps[0]).getUTCFullYear();
      const dateObj = new Date(Date.UTC(year, parseInt(month) - 1, parseInt(day)));
      const time = Math.floor(dateObj.getTime() / 1000);

      return {
        time,
        open,
        high,
        low,
        close,
      };
    });

  // Sort by time
  return candleData.sort((a, b) => a.time - b.time);
}

SentimentCandleChart.propTypes = {
  data: PropTypes.arrayOf(PropTypes.shape({
    date: PropTypes.string.isRequired,
    sentiment: PropTypes.number.isRequired,
    timestamp: PropTypes.string.isRequired,
  })).isRequired,
};

import { useEffect, useRef } from 'react';
import { createChart, BaselineSeries, LineSeries } from 'lightweight-charts';
import PropTypes from 'prop-types';

export function SentimentLineChart({ data }) {
  const chartContainerRef = useRef();
  const chartRef = useRef();
  const tooltipRef = useRef();

  useEffect(() => {
    if (!chartContainerRef.current || data.length === 0) return;

    const container = chartContainerRef.current;

    // Create chart
    const chart = createChart(container, {
      width: chartContainerRef.current.clientWidth,
      height: 300,
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
        barSpacing: 12,
        minBarSpacing: 4,
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
          top: 0.08,
          bottom: 0.08,
        },
        visible: true,
        autoScale: false,
      },
      crosshair: {
        mode: 1,
        vertLine: {
          color: '#97979B',
          width: 1,
          style: 3,
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

    // Add sentiment baseline series
    const sentimentSeries = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 50 },
      topLineColor: '#4CBB17',
      topFillColor1: 'rgba(76, 187, 23, 0.28)',
      topFillColor2: 'rgba(76, 187, 23, 0.05)',
      bottomLineColor: '#ef4444',
      bottomFillColor1: 'rgba(239, 68, 68, 0.05)',
      bottomFillColor2: 'rgba(239, 68, 68, 0.28)',
      lineWidth: 2,
      priceLineVisible: false,
    });

    // Add Tomek sentiment as a simple line overlay
    const tomekSeries = chart.addSeries(LineSeries, {
      color: '#808080',
      lineWidth: 1,
      priceLineVisible: false,
    });

    // Transform data
    const sentimentData = data.map(item => {
      const [day, month] = item.date.split('.');
      const year = new Date(item.timestamp).getUTCFullYear();
      const dateObj = new Date(Date.UTC(year, parseInt(month) - 1, parseInt(day)));
      const time = Math.floor(dateObj.getTime() / 1000);
      
      return {
        time,
        value: item.sentiment,
      };
    });

    const tomekData = data
      .filter(item => item.tomekSentiment !== null)
      .map(item => {
        const [day, month] = item.date.split('.');
        const year = new Date(item.timestamp).getUTCFullYear();
        const dateObj = new Date(Date.UTC(year, parseInt(month) - 1, parseInt(day)));
        const time = Math.floor(dateObj.getTime() / 1000);
        
        return {
          time,
          value: item.tomekSentiment,
        };
      });

    sentimentSeries.setData(sentimentData);
    tomekSeries.setData(tomekData);

    // Create tooltip element
    const toolTip = document.createElement('div');
    toolTip.style.cssText = `
      width: auto;
      white-space: nowrap;
      height: 300px;
      position: absolute;
      display: none;
      padding: 8px;
      box-sizing: border-box;
      font-size: 12px;
      text-align: left;
      z-index: 1000;
      top: 0;
      left: 0;
      pointer-events: none;
      border-radius: 4px 4px 0 0;
      border-bottom: none;
      box-shadow: 0 2px 5px 0 rgba(117, 134, 150, 0.45);
      font-family: -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    `;
    toolTip.style.background = 'rgba(255, 255, 255, 0.25)';
    toolTip.style.color = 'black';
    toolTip.style.borderColor = '#d1d5db';
    container.appendChild(toolTip);
    tooltipRef.current = toolTip;

    // Set explicit price range to show 0-100
    chart.priceScale('right').applyOptions({
      autoScale: false,
    });
    chart.priceScale('right').setVisibleRange({ from: 0, to: 100 });

    // Show last 30 days
    if (sentimentData.length > 0) {
      const latestTime = sentimentData[sentimentData.length - 1].time;
      const thirtyDaysAgo = latestTime - 30 * 24 * 60 * 60;
      chart.timeScale().setVisibleRange({ from: thirtyDaysAgo, to: latestTime });
    } else {
      chart.timeScale().fitContent();
    }

    // Add tooltip tracking
    chart.subscribeCrosshairMove((param) => {
      if (
        !param.time ||
        !param.point ||
        param.point.x < 0 ||
        param.point.x > container.clientWidth ||
        param.point.y < 0 ||
        param.point.y > container.clientHeight
      ) {
        toolTip.style.display = 'none';
        return;
      }

      const sentimentData = param.seriesData.get(sentimentSeries);
      const tomekData = param.seriesData.get(tomekSeries);

      if (!sentimentData && !tomekData) {
        toolTip.style.display = 'none';
        return;
      }

      const date = new Date(param.time * 1000);
      const day = date.getUTCDate();
      const months = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
      const month = months[date.getUTCMonth()];
      const year = date.getUTCFullYear();
      
      toolTip.style.display = 'block';
      
      let html = `<div style="font-weight: 600; margin-bottom: 4px;">${day} ${month} ${year}</div>`;
      
      if (sentimentData) {
        html += `<div>Krach & Śmieciuch Index: <span style="font-weight: 500;">${sentimentData.value.toFixed(2)}</span></div>`;
      }
      
      if (tomekData && tomekData.value !== null) {
        html += `<div>TomekIndicator®: <span style="font-weight: 500;">${tomekData.value.toFixed(2)}</span></div>`;
      }
      
      toolTip.innerHTML = html;

      let left = param.point.x;
      const timeScaleWidth = chart.timeScale().width();
      const priceScaleWidth = chart.priceScale('left').width();
      const halfTooltipWidth = toolTip.offsetWidth / 2;
      left += priceScaleWidth - halfTooltipWidth;
      left = Math.min(left, priceScaleWidth + timeScaleWidth - toolTip.offsetWidth);
      left = Math.max(left, priceScaleWidth);

      toolTip.style.left = left + 'px';
      toolTip.style.top = '0px';
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

// Create legend HTML
function createLegend() {
  return (
    <div className="flex items-center justify-center gap-4 mt-2 text-sm">
      <div className="flex items-center gap-2">
        <div className="w-4 h-0.5 bg-[#4CBB17]"></div>
        <span className="text-[#2D2D31]">Krach & Śmieciuch Index</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="w-4 h-0.5 bg-[#808080]"></div>
        <span className="text-[#2D2D31]">TomekIndicator®</span>
      </div>
    </div>
  );
}

export function SentimentLineChartWithLegend({ data }) {
  return (
    <div>
      <SentimentLineChart data={data} />
      {createLegend()}
    </div>
  );
}

SentimentLineChartWithLegend.propTypes = {
  data: PropTypes.arrayOf(PropTypes.shape({
    date: PropTypes.string.isRequired,
    sentiment: PropTypes.number.isRequired,
    tomekSentiment: PropTypes.number,
    timestamp: PropTypes.string.isRequired,
  })).isRequired,
};

SentimentLineChart.propTypes = {
  data: PropTypes.arrayOf(PropTypes.shape({
    date: PropTypes.string.isRequired,
    sentiment: PropTypes.number.isRequired,
    tomekSentiment: PropTypes.number,
    timestamp: PropTypes.string.isRequired,
  })).isRequired,
};

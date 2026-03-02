import { useEffect, useRef } from 'react';
import { createChart, AreaSeries } from 'lightweight-charts';
import PropTypes from 'prop-types';

export function FollowersChart({ data }) {
  const chartContainerRef = useRef();
  const chartRef = useRef();

  useEffect(() => {
    if (!chartContainerRef.current || data.length === 0) return;

    // Create chart
    const chart = createChart(chartContainerRef.current, {
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
        barSpacing: 20,
        minBarSpacing: 6,
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
          top: 0.15,
          bottom: 0.05,
        },
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

    // Add area series for followers
    const followersSeries = chart.addSeries(AreaSeries, {
      topColor: 'rgba(205, 127, 50, 0.4)',
      bottomColor: 'rgba(205, 127, 50, 0.05)',
      lineColor: '#CD7F32',
      lineWidth: 2,
      priceFormat: {
        type: 'custom',
        formatter: (price) => {
          return Math.round(price).toLocaleString('pl-PL');
        },
      },
    });

    // Transform data
    const followersData = data.map(item => {
      const [day, month] = item.date.split('.');
      const year = new Date(item.timestamp).getUTCFullYear();
      const dateObj = new Date(Date.UTC(year, parseInt(month) - 1, parseInt(day)));
      const time = Math.floor(dateObj.getTime() / 1000);
      
      return {
        time,
        value: item.followers,
      };
    });

    followersSeries.setData(followersData);

    // Fit content
    chart.timeScale().fitContent();

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [data]);

  return <div ref={chartContainerRef} className="w-full" />;
}

FollowersChart.propTypes = {
  data: PropTypes.arrayOf(PropTypes.shape({
    date: PropTypes.string.isRequired,
    followers: PropTypes.number.isRequired,
    timestamp: PropTypes.string.isRequired,
  })).isRequired,
};

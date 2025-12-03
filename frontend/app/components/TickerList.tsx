'use client';

import React from 'react';
import StockTicker from './StockTicker';

interface TickerListProps {
  symbols: string[];
  onSelectStock: (symbol: string) => void;
  selectedStock: string;
  onRemoveStock?: (symbol: string) => void;
}

const TickerList: React.FC<TickerListProps> = ({ symbols, onSelectStock, selectedStock, onRemoveStock }) => {
  const safeOnRemoveStock = onRemoveStock || (() => {});
  return (
    <div className="flex gap-0.5 overflow-x-auto pb-1 scrollbar-thin scrollbar-thumb-[var(--color-border)] scrollbar-track-transparent">
      {symbols.map((symbol) => (
        <div key={symbol} className="flex-shrink-0 min-w-[80px] w-24 sm:w-28 flex-grow">
          <StockTicker
            symbol={symbol}
            onSelect={onSelectStock}
            isSelected={selectedStock === symbol}
            onRemove={() => safeOnRemoveStock(symbol)}
          />
        </div>
      ))}
    </div>
  );
};

export default TickerList;

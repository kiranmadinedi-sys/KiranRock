'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { debounce } from 'lodash';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { getApiBaseUrl } from '../config';

interface StockResult {
    symbol: string;
    name: string;
    type: string;
    exchange: string;
}

interface StockSearchProps {
    onSelectStock: (symbol: string) => void;
}

const StockSearch: React.FC<StockSearchProps> = ({ onSelectStock }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [results, setResults] = useState<StockResult[]>([]);
    const [isLoading, setIsLoading] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const updateDropdownPosition = useCallback(() => {
    if (inputRef.current) {
      const rect = inputRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
        width: rect.width,
      });
    }
  }, []);

  useEffect(() => {
    if (showDropdown) {
      updateDropdownPosition();
      const handleResize = () => updateDropdownPosition();
      const handleScroll = () => updateDropdownPosition();
      window.addEventListener('resize', handleResize);
      window.addEventListener('scroll', handleScroll);
      return () => {
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('scroll', handleScroll);
      };
    }
  }, [showDropdown, updateDropdownPosition]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (inputRef.current && !inputRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };

    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showDropdown]);

  const debouncedSearch = useCallback(
    debounce(async (query: string) => {
      if (query.length < 2) {
        setResults([]);
        setShowDropdown(false);
        return;
      }

      try {
        // Make unauthenticated request since backend routes are currently unprotected
        const response = await fetch(`${getApiBaseUrl()}/api/stocks/search?query=${encodeURIComponent(query)}`);

        if (response.ok) {
          const data = await response.json();
          setResults(data);
          setShowDropdown(data.length > 0);
        } else {
          console.error('Search failed:', response.status);
          setResults([]);
          setShowDropdown(false);
        }
      } catch (error) {
        console.error('Search error:', error);
        setResults([]);
        setShowDropdown(false);
      }
    }, 300),
    []
  );

  useEffect(() => {
    debouncedSearch(searchTerm);
  }, [searchTerm, debouncedSearch]);

    const handleSelect = (symbol: string) => {
    console.log('[StockSearch] Selected symbol:', symbol);
    setSearchTerm('');
    setResults([]);
    setShowDropdown(false);
    if (typeof onSelectStock === 'function') {
      onSelectStock(symbol);
    } else {
      console.error('[StockSearch] onSelectStock is not a function:', onSelectStock);
    }
    };

    return (
    <div className="relative w-full isolate" style={{ zIndex: 99999 }}>
      <input
        ref={inputRef}
        type="text"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        placeholder="Search stocks..."
        className="w-full p-2 border border-[var(--color-border)] rounded-md bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] placeholder-[var(--color-text-secondary)] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent relative"
        style={{ zIndex: 1 }}
      />
            {isLoading && (
                <div className="absolute w-full mt-1 text-center text-[var(--color-text-secondary)] bg-[var(--color-card)] border border-[var(--color-border)] rounded-md p-2 shadow-2xl" style={{ zIndex: 999999 }}>Loading...</div>
            )}
      {showDropdown && results.length > 0 && createPortal(
        <ul 
          className="fixed bg-[var(--color-card)] border-2 border-[var(--color-accent)] rounded-md shadow-2xl max-h-60 overflow-y-auto"
          style={{ 
            top: dropdownPosition.top, 
            left: dropdownPosition.left, 
            width: dropdownPosition.width,
            zIndex: 999999 
          }}
        >
          {results.map((stock) => (
            <li
              key={stock.symbol}
              tabIndex={0}
              role="button"
              onMouseDown={(e) => {
                // Use onMouseDown to ensure event fires before blur/hide
                e.preventDefault();
                handleSelect(stock.symbol);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleSelect(stock.symbol);
                }
              }}
              className="p-3 cursor-pointer hover:bg-[var(--color-accent)] hover:text-white text-[var(--color-text-primary)] border-b border-[var(--color-border)] last:border-b-0 transition-all duration-150 focus:outline-none"
            >
              <div className="flex flex-col">
                <span className="font-bold">{stock.symbol}</span>
                <span className="text-sm opacity-75">{stock.name}</span>
              </div>
            </li>
          ))}
        </ul>,
        document.body
      )}
        </div>
    );
};

export default StockSearch;

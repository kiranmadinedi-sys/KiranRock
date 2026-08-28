'use client';

import React from 'react';

import CryptoTradingView from '../components/CryptoTradingView';

export default function CryptoTradingPage() {
    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
            <main className="max-w-7xl mx-auto px-4 py-6">
                <div className="mb-6">
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-3">
                        <span className="text-4xl">₿</span>
                        Crypto Trading
                    </h1>
                    <p className="text-gray-600 dark:text-gray-400 mt-2">
                        24/7 automated crypto trading — opt-in, fully isolated from your equity positions
                    </p>
                </div>

                <CryptoTradingView />
            </main>
        </div>
    );
}

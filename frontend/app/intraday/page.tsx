'use client';

import React from 'react';

import IntradayBotView from '../components/IntradayBotView';

export default function IntradayPage() {
    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">

            <main className="max-w-7xl mx-auto px-4 py-6">
                <div className="mb-6">
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-3">
                        <span className="text-4xl">⚡</span>
                        Blitz — Autonomous Intraday Trading
                    </h1>
                    <p className="text-gray-600 dark:text-gray-400 mt-2">
                        A separate, opt-in intraday agent with its own fixed capital, positions, and schedule
                    </p>
                </div>

                <IntradayBotView />
            </main>
        </div>
    );
}

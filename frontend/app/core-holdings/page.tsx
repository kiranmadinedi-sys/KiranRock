'use client';

import React from 'react';

import CoreHoldingsView from '../components/CoreHoldingsView';
import CoreWatchlist from '../components/CoreWatchlist';
import CoreGuidance from '../components/CoreGuidance';

export default function CoreHoldingsPage() {
    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
            <main className="max-w-7xl mx-auto px-4 py-6">
                <div className="mb-6">
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-3">
                        <span className="text-4xl">🏛️</span>
                        Core Holdings
                    </h1>
                    <p className="text-gray-600 dark:text-gray-400 mt-2">
                        Long-term positions for idle cash — opt-in, kept separate from swing trading
                    </p>
                </div>

                <CoreHoldingsView />
                <CoreGuidance />
                <CoreWatchlist />
            </main>
        </div>
    );
}

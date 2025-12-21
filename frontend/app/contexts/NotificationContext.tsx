'use client';
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { getApiBaseUrl } from '../config';

interface NewsAlert {
    id: string;
    symbol: string;
    title: string;
    summary: string;
    link: string;
    impact: string;
    severity: 'Low' | 'Medium' | 'High';
    sentimentImpact: string;
    sentimentScore: number;
    keywords: string[];
    createdAt: string;
    read: boolean;
}

interface NotificationContextType {
    alerts: NewsAlert[];
    unreadCount: number;
    fetchAlerts: () => Promise<void>;
    markAsRead: (id: string) => Promise<void>;
    showNotification: (alert: NewsAlert) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export const useNotifications = () => {
    const context = useContext(NotificationContext);
    if (!context) {
        throw new Error('useNotifications must be used within NotificationProvider');
    }
    return context;
};

interface NotificationProviderProps {
    children: ReactNode;
}

export const NotificationProvider: React.FC<NotificationProviderProps> = ({ children }) => {
    const [alerts, setAlerts] = useState<NewsAlert[]>([]);
    const [displayedAlert, setDisplayedAlert] = useState<NewsAlert | null>(null);

    const fetchAlerts = async () => {
        try {
            // For testing, use a hardcoded token
            const token = getAuthToken() || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjhlMTgyZTg5LTAyOTYtNDhhZS04MjMwLTU2MGZjYzIwYzMyNiIsImlhdCI6MTc2MjU5NjQ0NSwiZXhwIjoxNzYyNjAwMDQ1fQ.n7ij5ecUcOa1DbWL-_y-0pcVi3TSF4a6Em2Nd7jQTN8';
            if (!token) {
                console.log('No auth token available for fetching alerts');
                return;
            }

            console.log('Fetching alerts with token:', token.substring(0, 20) + '...');
            const apiUrl = getApiBaseUrl();
            const response = await fetch(`${apiUrl}/api/news-alerts?limit=20`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (response.status === 401) {
                console.log('Auth failed, trying without auth for testing');
                // Try without auth for testing
                const testResponse = await fetch(`${apiUrl}/api/news-alerts?limit=20`);
                if (testResponse.ok) {
                    const data = await testResponse.json();
                    console.log('Fetched alerts without auth:', data.alerts.length, 'alerts');
                    setAlerts(data.alerts || []);
                    
                    // Show pop-up for new unread high-severity alerts
                    const newHighSeverity = data.alerts.filter(
                        (a: NewsAlert) => !a.read && a.severity === 'High'
                    );
                    
                    console.log('New high-severity alerts:', newHighSeverity.length);
                    if (newHighSeverity.length > 0) {
                        console.log('Showing popup for alert:', newHighSeverity[0].title);
                        setDisplayedAlert(newHighSeverity[0]);
                    }
                }
                return;
            }

            if (response.ok) {
                const data = await response.json();
                console.log('Fetched alerts:', data.alerts.length, 'alerts');
                setAlerts(data.alerts || []);
                
                // Show pop-up for new unread high-severity alerts
                const newHighSeverity = data.alerts.filter(
                    (a: NewsAlert) => !a.read && a.severity === 'High'
                );
                
                console.log('New high-severity alerts:', newHighSeverity.length);
                if (newHighSeverity.length > 0) {
                    console.log('Showing popup for alert:', newHighSeverity[0].title);
                    setDisplayedAlert(newHighSeverity[0]);
                }
            } else {
                console.error('Failed to fetch alerts:', response.status);
            }
        } catch (error) {
            console.error('Error fetching alerts:', error);
        }
    };

    const markAsRead = async (id: string) => {
        try {
            const token = getAuthToken();
            if (!token) return;

            const response = await fetch(`${getApiBaseUrl()}/api/news-alerts/${id}/read`, {
                method: 'PUT',
                headers: { Authorization: `Bearer ${token}` }
            });

            if (response.status === 401) {
                handleAuthError(response.status);
                return;
            }

            setAlerts(prev => prev.map(a => a.id === id ? { ...a, read: true } : a));
            
            if (displayedAlert?.id === id) {
                setDisplayedAlert(null);
            }
        } catch (error) {
            console.error('Error marking alert as read:', error);
        }
    };

    const showNotification = (alert: NewsAlert) => {
        setDisplayedAlert(alert);
    };

    useEffect(() => {
        fetchAlerts();
        
        // Poll for new alerts every 2 minutes
        const interval = setInterval(fetchAlerts, 2 * 60 * 1000);
        
        return () => clearInterval(interval);
    }, []);

    const unreadCount = alerts.filter(a => !a.read).length;

    return (
        <NotificationContext.Provider
            value={{ alerts, unreadCount, fetchAlerts, markAsRead, showNotification }}
        >
            {children}
            
            {/* News Alert Pop-up */}
            {displayedAlert && (
                <div className="fixed bottom-4 right-4 z-50 max-w-md animate-slide-up">
                    <div className={`rounded-lg shadow-2xl p-4 border-l-4 ${
                        displayedAlert.severity === 'High' 
                            ? 'bg-red-50 dark:bg-red-900/20 border-red-500'
                            : 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-500'
                    }`}>
                        <div className="flex items-start justify-between">
                            <div className="flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="font-bold text-lg">{displayedAlert.symbol}</span>
                                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                                        displayedAlert.severity === 'High'
                                            ? 'bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-100'
                                            : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-100'
                                    }`}>
                                        {displayedAlert.severity} Impact
                                    </span>
                                </div>
                                <h4 className="font-semibold text-gray-900 dark:text-white mb-1">
                                    {displayedAlert.title}
                                </h4>
                                <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                                    {displayedAlert.summary.substring(0, 150)}...
                                </p>
                                <div className="flex items-center gap-2">
                                    <a
                                        href={displayedAlert.link}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                                    >
                                        Read full article →
                                    </a>
                                </div>
                            </div>
                            <button
                                onClick={() => markAsRead(displayedAlert.id)}
                                className="ml-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                            >
                                ✕
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </NotificationContext.Provider>
    );
};

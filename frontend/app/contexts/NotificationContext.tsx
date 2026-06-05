'use client';
import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { getApiBaseUrl } from '../config';

interface NewsAlert {
    id: string;
    type: 'news' | 'swing';
    symbol: string;
    title: string;
    summary: string;
    link?: string | null;
    impact?: string | null;
    severity?: 'Low' | 'Medium' | 'High' | null;
    sentimentImpact?: string | null;
    sentimentScore?: number | null;
    keywords?: string[];
    signal?: string | null;
    sourceLabel?: string;
    popupEligible?: boolean;
    priorityScore?: number;
    createdAt: string;
    read: boolean;
}

type PopupMode = 'off' | 'news' | 'swing' | 'both';

interface PopupPreferences {
    popupMode: PopupMode;
    popupMinPriority: number;
}

interface NotificationContextType {
    alerts: NewsAlert[];
    unreadCount: number;
    popupUnreadCount: number;
    fetchAlerts: () => Promise<void>;
    markAsRead: (id: string) => Promise<void>;
    showNotification: (alert: NewsAlert) => void;
    popupPreferences: PopupPreferences;
    updatePopupPreferences: (updates: Partial<PopupPreferences>) => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);
const DEFAULT_POPUP_PREFERENCES: PopupPreferences = {
    popupMode: 'both',
    popupMinPriority: 72
};

export const useNotifications = () => {
    const context = useContext(NotificationContext);
    if (!context) throw new Error('useNotifications must be used within NotificationProvider');
    return context;
};

export const NotificationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [alerts, setAlerts] = useState<NewsAlert[]>([]);
    const [displayedAlert, setDisplayedAlert] = useState<NewsAlert | null>(null);
    const [popupPreferences, setPopupPreferences] = useState<PopupPreferences>(DEFAULT_POPUP_PREFERENCES);
    // Track IDs dismissed this session so they don't reappear on next poll
    const dismissedIdsRef = useRef<Set<string>>(new Set());
    const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showAlert = (alert: NewsAlert) => {
        if (dismissedIdsRef.current.has(alert.id)) return;
        setDisplayedAlert(alert);
        // Auto-dismiss after 12 seconds
        if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
        autoDismissRef.current = setTimeout(() => setDisplayedAlert(null), 12000);
    };

    const dismiss = (id: string) => {
        dismissedIdsRef.current.add(id);
        setDisplayedAlert(null);
        if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    };

    const fetchAlerts = async () => {
        try {
            const token = getAuthToken();
            if (!token) return;

            const response = await fetch(`${getApiBaseUrl()}/api/stock-feed?limit=20`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (response.status === 401) {
                handleAuthError(response.status);
                return;
            }
            if (!response.ok) return;

            const data = await response.json();
            setAlerts(data.items || []);
            if (data.preferences) {
                setPopupPreferences(data.preferences);
            }

            const candidate = (data.items as NewsAlert[]).find(
                (alert) => alert.popupEligible && !alert.read && !dismissedIdsRef.current.has(alert.id)
            );
            if (candidate) showAlert(candidate);

        } catch (error) {
            console.error('[Notifications] Fetch error:', error);
        }
    };

    const updatePopupPreferences = async (updates: Partial<PopupPreferences>) => {
        try {
            const token = getAuthToken();
            if (!token) return;

            const response = await fetch(`${getApiBaseUrl()}/api/stock-feed/preferences`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({
                    popupMode: updates.popupMode ?? popupPreferences.popupMode,
                    popupMinPriority: updates.popupMinPriority ?? popupPreferences.popupMinPriority
                })
            });

            if (response.status === 401) {
                handleAuthError(response.status);
                return;
            }

            if (!response.ok) {
                return;
            }

            const data = await response.json();
            if (data.preferences) {
                setPopupPreferences(data.preferences);
            }
            await fetchAlerts();
        } catch (error) {
            console.error('[Notifications] updatePopupPreferences error:', error);
        }
    };

    const markAsRead = async (id: string) => {
        dismiss(id); // hide popup immediately regardless of API result
        try {
            const token = getAuthToken();
            if (!token) return;

            const alert = alerts.find((item) => item.id === id);
            const response = await fetch(`${getApiBaseUrl()}/api/stock-feed/${encodeURIComponent(id)}/read`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ type: alert?.type })
            });
            if (response.status === 401) { handleAuthError(response.status); return; }
            setAlerts(prev => prev.map(a => a.id === id ? { ...a, read: true } : a));
        } catch (error) {
            console.error('[Notifications] markAsRead error:', error);
        }
    };

    const showNotification = (alert: NewsAlert) => showAlert(alert);

    useEffect(() => {
        fetchAlerts();
        const interval = setInterval(fetchAlerts, 2 * 60 * 1000);
        return () => {
            clearInterval(interval);
            if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
        };
    }, []);

    const unreadCount = alerts.filter(a => !a.read).length;
    const popupUnreadCount = alerts.filter((alert) => !alert.read && alert.popupEligible).length;

    return (
        <NotificationContext.Provider value={{ alerts, unreadCount, popupUnreadCount, fetchAlerts, markAsRead, showNotification, popupPreferences, updatePopupPreferences }}>
            {children}

            {displayedAlert && (
                <div className="fixed bottom-4 right-4 z-50 max-w-sm animate-slide-up">
                    <div className={`rounded-lg shadow-2xl p-4 border-l-4 ${
                        displayedAlert.type === 'swing'
                            ? 'bg-emerald-50 border-emerald-500'
                            : displayedAlert.severity === 'High'
                                ? 'bg-red-50 border-red-500'
                                : 'bg-yellow-50 border-yellow-500'
                    }`}>
                        <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="font-bold text-gray-900">{displayedAlert.symbol}</span>
                                    <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${
                                        displayedAlert.type === 'swing'
                                            ? 'bg-emerald-100 text-emerald-800'
                                            : displayedAlert.severity === 'High'
                                                ? 'bg-red-100 text-red-800'
                                                : 'bg-yellow-100 text-yellow-800'
                                    }`}>
                                        {displayedAlert.type === 'swing'
                                            ? displayedAlert.signal || 'Swing'
                                            : `${displayedAlert.severity || 'News'} Impact`}
                                    </span>
                                </div>
                                <h4 className="font-semibold text-gray-900 text-sm mb-1 leading-snug">
                                    {displayedAlert.title}
                                </h4>
                                <p className="text-xs text-gray-500 mb-2 line-clamp-2">
                                    {displayedAlert.summary?.substring(0, 120)}…
                                </p>
                                {displayedAlert.sourceLabel && (
                                    <p className="text-[11px] font-medium text-gray-600 mb-2">{displayedAlert.sourceLabel}</p>
                                )}
                                <a
                                    href={displayedAlert.link || '/alerts'}
                                    target={displayedAlert.link ? '_blank' : undefined}
                                    rel={displayedAlert.link ? 'noopener noreferrer' : undefined}
                                    className="text-xs text-blue-600 hover:underline"
                                    onClick={() => markAsRead(displayedAlert.id)}
                                >
                                    {displayedAlert.link ? 'Read full article →' : 'Open alerts center →'}
                                </a>
                            </div>
                            <button
                                onClick={() => markAsRead(displayedAlert.id)}
                                className="shrink-0 text-gray-400 hover:text-gray-700 text-lg leading-none mt-0.5"
                                aria-label="Dismiss"
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

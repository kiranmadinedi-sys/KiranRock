'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Logo from '../components/Logo';
import { API_BASE_URL } from '../config/apiConfig';
import ThemeToggle from '../components/ThemeToggle';

interface UserProfile {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    createdAt: string;
    aiTradingEnabled: boolean;
    tradingAccount: {
        balance: number;
        totalDeposited: number;
        totalWithdrawn: number;
    };
}

export default function ProfilePage() {
    const router = useRouter();
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    
    // Profile data
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [firstName, setFirstName] = useState('');
    const [lastName, setLastName] = useState('');
    const [email, setEmail] = useState('');
    const [phone, setPhone] = useState('');
    
    // Password change
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [passwordMessage, setPasswordMessage] = useState('');
    const [passwordError, setPasswordError] = useState('');
    
    // AI Trading
    const [aiTradingEnabled, setAiTradingEnabled] = useState(false);
    const [aiTradingLoading, setAiTradingLoading] = useState(false);
    
    // Active section
    const [activeSection, setActiveSection] = useState<'profile' | 'password' | 'account' | 'ai'>('profile');

    useEffect(() => {
        const storedToken = localStorage.getItem('token');
        if (!storedToken) {
            router.push('/login');
        } else {
            setToken(storedToken);
        }
    }, [router]);

    useEffect(() => {
        if (!token) return;
        fetchProfile();
    }, [token]);

    const fetchProfile = async () => {
        setLoading(true);
        try {
            const response = await fetch(`${API_BASE_URL}/api/profile`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (response.ok) {
                const data = await response.json();
                setProfile(data);
                setFirstName(data.firstName || '');
                setLastName(data.lastName || '');
                setEmail(data.email || '');
                setPhone(data.phone || '');
                setAiTradingEnabled(data.aiTradingEnabled || false);
            }
        } catch (error) {
            console.error('Failed to fetch profile:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleUpdateProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        try {
            const response = await fetch(`${API_BASE_URL}/api/profile`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ firstName, lastName, email, phone })
            });
            
            if (response.ok) {
                const data = await response.json();
                setProfile(data);
                alert('Profile updated successfully!');
            } else {
                const error = await response.json();
                alert(`Error: ${error.error}`);
            }
        } catch (error) {
            console.error('Failed to update profile:', error);
            alert('Failed to update profile');
        } finally {
            setSaving(false);
        }
    };

    const handleChangePassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setPasswordMessage('');
        setPasswordError('');
        
        if (newPassword !== confirmPassword) {
            setPasswordError('New passwords do not match');
            return;
        }
        
        if (newPassword.length < 6) {
            setPasswordError('Password must be at least 6 characters');
            return;
        }
        
        setSaving(true);
        try {
            const response = await fetch(`${API_BASE_URL}/api/profile/change-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ currentPassword, newPassword })
            });
            
            const data = await response.json();
            
            if (response.ok) {
                setPasswordMessage('Password changed successfully!');
                setCurrentPassword('');
                setNewPassword('');
                setConfirmPassword('');
            } else {
                setPasswordError(data.error || 'Failed to change password');
            }
        } catch (error) {
            console.error('Failed to change password:', error);
            setPasswordError('Failed to change password');
        } finally {
            setSaving(false);
        }
    };

    const handleToggleAITrading = async () => {
        setAiTradingLoading(true);
        try {
            const response = await fetch(`${API_BASE_URL}/api/profile/ai-trading/toggle`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ enabled: !aiTradingEnabled })
            });
            
            const data = await response.json();
            
            if (response.ok) {
                setAiTradingEnabled(!aiTradingEnabled);
                alert(data.message);
            } else {
                alert(`Error: ${data.error}`);
            }
        } catch (error) {
            console.error('Failed to toggle AI trading:', error);
            alert('Failed to toggle AI trading');
        } finally {
            setAiTradingLoading(false);
        }
    };

    const handleLogout = () => {
        localStorage.removeItem('token');
        setToken(null);
        router.push('/login');
    };

    if (!token || loading) {
        return (
            <div className="min-h-screen bg-[var(--color-bg-primary)] flex items-center justify-center">
                <div className="text-[var(--color-text-primary)]">Loading profile...</div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[var(--color-bg-primary)]">
            {/* Header */}
            <header className="bg-[var(--color-card)] border-b border-[var(--color-border)] shadow-sm sticky top-0 z-50">
                <div className="max-w-7xl mx-auto px-4 py-3">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-6">
                            <Link href="/dashboard">
                                <Logo />
                            </Link>
                            <nav className="hidden md:flex items-center space-x-1">
                                <Link 
                                    href="/dashboard" 
                                    className="text-[var(--color-text-secondary)] font-semibold py-2 px-4 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors"
                                >
                                    Dashboard
                                </Link>
                                <Link 
                                    href="/alerts" 
                                    className="text-[var(--color-text-secondary)] font-semibold py-2 px-4 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors"
                                >
                                    Alerts
                                </Link>
                                <Link 
                                    href="/portfolio" 
                                    className="text-[var(--color-text-secondary)] font-semibold py-2 px-4 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors"
                                >
                                    Portfolio
                                </Link>
                                <Link 
                                    href="/weekly" 
                                    className="text-[var(--color-text-secondary)] font-semibold py-2 px-4 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors"
                                >
                                    📅 Next Week
                                </Link>
                                <Link 
                                    href="/profile" 
                                    className="bg-[var(--color-accent)] text-white font-semibold py-2 px-4 rounded-lg transition-colors"
                                >
                                    Profile
                                </Link>
                            </nav>
                        </div>
                        <div className="flex items-center space-x-4">
                            <ThemeToggle />
                            <button
                                onClick={handleLogout}
                                className="text-[var(--color-text-secondary)] hover:text-[var(--color-danger)] font-semibold py-2 px-4 rounded-lg transition-colors"
                            >
                                Logout
                            </button>
                        </div>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <div className="max-w-5xl mx-auto px-4 py-8">
                {/* Page Title */}
                <div className="mb-8">
                    <h1 className="text-3xl font-bold text-[var(--color-text-primary)] mb-2">
                        Profile Settings
                    </h1>
                    <p className="text-[var(--color-text-secondary)]">
                        Manage your account information and preferences
                    </p>
                </div>

                {/* Navigation Tabs */}
                <div className="flex border-b border-[var(--color-border)] mb-6">
                    <button
                        onClick={() => setActiveSection('profile')}
                        className={`px-6 py-3 font-semibold border-b-2 transition-all ${
                            activeSection === 'profile'
                                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                        }`}
                    >
                        👤 Profile Information
                    </button>
                    <button
                        onClick={() => setActiveSection('password')}
                        className={`px-6 py-3 font-semibold border-b-2 transition-all ${
                            activeSection === 'password'
                                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                        }`}
                    >
                        🔒 Change Password
                    </button>
                    <button
                        onClick={() => setActiveSection('account')}
                        className={`px-6 py-3 font-semibold border-b-2 transition-all ${
                            activeSection === 'account'
                                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                        }`}
                    >
                        💰 Trading Account
                    </button>
                    <button
                        onClick={() => setActiveSection('ai')}
                        className={`px-6 py-3 font-semibold border-b-2 transition-all ${
                            activeSection === 'ai'
                                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                        }`}
                    >
                        🤖 AI Trading
                    </button>
                </div>

                {/* Profile Information Section */}
                {activeSection === 'profile' && (
                    <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] p-6">
                        <h2 className="text-xl font-bold text-[var(--color-text-primary)] mb-4">
                            Personal Information
                        </h2>
                        <form onSubmit={handleUpdateProfile} className="space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">First Name</label>
                                    <input
                                        type="text"
                                        value={firstName}
                                        onChange={(e) => setFirstName(e.target.value)}
                                        className="w-full px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                                        placeholder="Enter first name"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">Last Name</label>
                                    <input
                                        type="text"
                                        value={lastName}
                                        onChange={(e) => setLastName(e.target.value)}
                                        className="w-full px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                                        placeholder="Enter last name"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">Email Address</label>
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="w-full px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                                    placeholder="Enter email address"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">Phone Number</label>
                                <input
                                    type="tel"
                                    value={phone}
                                    onChange={(e) => setPhone(e.target.value)}
                                    className="w-full px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                                    placeholder="Enter phone number"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">Username (cannot be changed)</label>
                                <input
                                    type="text"
                                    value={profile?.username || ''}
                                    disabled
                                    className="w-full px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] cursor-not-allowed"
                                />
                            </div>
                            <div className="pt-4">
                                <button
                                    type="submit"
                                    disabled={saving}
                                    className="bg-[var(--color-accent)] text-white px-6 py-2 rounded-lg font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
                                >
                                    {saving ? 'Saving...' : 'Save Changes'}
                                </button>
                            </div>
                        </form>

                        {/* Account Info */}
                        <div className="mt-8 pt-6 border-t border-[var(--color-border)]">
                            <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">
                                Account Information
                            </h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                                <div className="bg-[var(--color-bg-tertiary)] p-4 rounded-lg">
                                    <div className="text-[var(--color-text-secondary)] mb-1">Account ID</div>
                                    <div className="font-mono text-[var(--color-text-primary)]">{profile?.id}</div>
                                </div>
                                <div className="bg-[var(--color-bg-tertiary)] p-4 rounded-lg">
                                    <div className="text-[var(--color-text-secondary)] mb-1">Member Since</div>
                                    <div className="text-[var(--color-text-primary)]">
                                        {profile?.createdAt ? new Date(profile.createdAt).toLocaleDateString() : 'N/A'}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Change Password Section */}
                {activeSection === 'password' && (
                    <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] p-6">
                        <h2 className="text-xl font-bold text-[var(--color-text-primary)] mb-4">
                            Change Password
                        </h2>
                        
                        {passwordMessage && (
                            <div className="mb-4 p-4 bg-green-500/10 border border-green-500 rounded-lg text-green-500">
                                {passwordMessage}
                            </div>
                        )}
                        
                        {passwordError && (
                            <div className="mb-4 p-4 bg-red-500/10 border border-red-500 rounded-lg text-red-500">
                                {passwordError}
                            </div>
                        )}
                        
                        <form onSubmit={handleChangePassword} className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                                    Current Password
                                </label>
                                <input
                                    type="password"
                                    value={currentPassword}
                                    onChange={(e) => setCurrentPassword(e.target.value)}
                                    required
                                    className="w-full px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                                    placeholder="Enter current password"
                                />
                            </div>
                            
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                                    New Password
                                </label>
                                <input
                                    type="password"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    required
                                    minLength={6}
                                    className="w-full px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                                    placeholder="Enter new password (min 6 characters)"
                                />
                            </div>
                            
                            <div>
                                <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                                    Confirm New Password
                                </label>
                                <input
                                    type="password"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    required
                                    minLength={6}
                                    className="w-full px-4 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                                    placeholder="Confirm new password"
                                />
                            </div>

                            <div className="pt-4">
                                <button
                                    type="submit"
                                    disabled={saving}
                                    className="bg-[var(--color-accent)] text-white px-6 py-2 rounded-lg font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
                                >
                                    {saving ? 'Changing Password...' : 'Change Password'}
                                </button>
                            </div>
                        </form>

                        <div className="mt-6 p-4 bg-[var(--color-bg-tertiary)] rounded-lg">
                            <h4 className="font-semibold text-[var(--color-text-primary)] mb-2">Password Requirements:</h4>
                            <ul className="text-sm text-[var(--color-text-secondary)] space-y-1 list-disc list-inside">
                                <li>At least 6 characters long</li>
                                <li>Use a strong, unique password</li>
                                <li>Don't reuse passwords from other sites</li>
                            </ul>
                        </div>
                    </div>
                )}

                {/* Trading Account Section */}
                {activeSection === 'account' && (
                    <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] p-6">
                        <h2 className="text-xl font-bold text-[var(--color-text-primary)] mb-4">
                            Trading Account Overview
                        </h2>
                        
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                            <div className="bg-[var(--color-bg-tertiary)] p-6 rounded-lg">
                                <div className="text-sm text-[var(--color-text-secondary)] mb-1">Current Balance</div>
                                <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                                    ${profile?.tradingAccount?.balance?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0.00'}
                                </div>
                            </div>
                            
                            <div className="bg-[var(--color-bg-tertiary)] p-6 rounded-lg">
                                <div className="text-sm text-[var(--color-text-secondary)] mb-1">Total Deposited</div>
                                <div className="text-2xl font-bold text-green-500">
                                    ${profile?.tradingAccount?.totalDeposited?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0.00'}
                                </div>
                            </div>
                            
                            <div className="bg-[var(--color-bg-tertiary)] p-6 rounded-lg">
                                <div className="text-sm text-[var(--color-text-secondary)] mb-1">Total Withdrawn</div>
                                <div className="text-2xl font-bold text-red-500">
                                    ${profile?.tradingAccount?.totalWithdrawn?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0.00'}
                                </div>
                            </div>
                        </div>

                        <div className="bg-blue-500/10 border border-blue-500 rounded-lg p-4">
                            <div className="flex items-start">
                                <div className="text-blue-500 text-2xl mr-3">ℹ️</div>
                                <div>
                                    <h4 className="font-semibold text-blue-500 mb-2">Paper Trading Account</h4>
                                    <p className="text-sm text-[var(--color-text-secondary)]">
                                        This is a simulated trading account with virtual money. Use it to test strategies and track performance without financial risk. 
                                        Go to the <Link href="/portfolio" className="text-[var(--color-accent)] hover:underline">Portfolio page</Link> to deposit more funds, place trades, and view your performance.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="mt-6 pt-6 border-t border-[var(--color-border)]">
                            <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">
                                Quick Actions
                            </h3>
                            <div className="flex gap-4">
                                <Link 
                                    href="/portfolio"
                                    className="bg-[var(--color-accent)] text-white px-6 py-3 rounded-lg font-semibold hover:opacity-90 transition-opacity"
                                >
                                    📊 View Portfolio
                                </Link>
                                <Link 
                                    href="/portfolio"
                                    className="bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] px-6 py-3 rounded-lg font-semibold hover:bg-[var(--color-bg-secondary)] transition-colors border border-[var(--color-border)]"
                                >
                                    💰 Deposit Funds
                                </Link>
                            </div>
                        </div>
                    </div>
                )}

                {/* AI Trading Section */}
                {activeSection === 'ai' && (
                    <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] p-6">
                        <h2 className="text-xl font-bold text-[var(--color-text-primary)] mb-4">
                            🤖 Automated AI Trading
                        </h2>
                        
                        <div className="mb-6">
                            <p className="text-[var(--color-text-secondary)] mb-4">
                                Enable AI to automatically manage your portfolio with intelligent buy/sell decisions, automatic stop-loss, and take-profit execution.
                            </p>
                        </div>

                        {/* AI Trading Toggle */}
                        <div className="bg-[var(--color-bg-tertiary)] rounded-lg p-6 mb-6">
                            <div className="flex items-center justify-between">
                                <div className="flex-1">
                                    <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">
                                        {aiTradingEnabled ? '✅ AI Trading is Active' : '⏸️ AI Trading is Disabled'}
                                    </h3>
                                    <p className="text-sm text-[var(--color-text-secondary)]">
                                        {aiTradingEnabled 
                                            ? 'AI is monitoring your portfolio and will automatically execute trades based on market signals, stop-loss (-15%), and take-profit (+30%) triggers.' 
                                            : 'Enable AI Trading to let the bot manage your portfolio automatically.'}
                                    </p>
                                </div>
                                <button
                                    onClick={handleToggleAITrading}
                                    disabled={aiTradingLoading}
                                    className={`ml-6 px-8 py-3 rounded-lg font-semibold transition-all ${
                                        aiTradingEnabled
                                            ? 'bg-red-500 hover:bg-red-600 text-white'
                                            : 'bg-green-500 hover:bg-green-600 text-white'
                                    } disabled:opacity-50`}
                                >
                                    {aiTradingLoading ? 'Processing...' : aiTradingEnabled ? 'Disable AI' : 'Enable AI'}
                                </button>
                            </div>
                        </div>

                        {/* AI Strategy Info */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                            <div className="bg-[var(--color-bg-tertiary)] p-4 rounded-lg">
                                <h4 className="font-semibold text-[var(--color-text-primary)] mb-3">📊 AI Strategy</h4>
                                <ul className="space-y-2 text-sm text-[var(--color-text-secondary)]">
                                    <li>• Diversified across 10 top stocks</li>
                                    <li>• Momentum + volume analysis</li>
                                    <li>• 10% cash reserve maintained</li>
                                    <li>• Max 20% per stock position</li>
                                </ul>
                            </div>
                            <div className="bg-[var(--color-bg-tertiary)] p-4 rounded-lg">
                                <h4 className="font-semibold text-[var(--color-text-primary)] mb-3">🛡️ Risk Management</h4>
                                <ul className="space-y-2 text-sm text-[var(--color-text-secondary)]">
                                    <li>• Stop-loss at -15%</li>
                                    <li>• Take-profit at +30%</li>
                                    <li>• Automatic rebalancing</li>
                                    <li>• Checks every 5 minutes</li>
                                </ul>
                            </div>
                        </div>

                        {/* How It Works */}
                        <div className="bg-blue-500/10 border border-blue-500 rounded-lg p-4">
                            <div className="flex items-start">
                                <div className="text-blue-500 text-2xl mr-3">ℹ️</div>
                                <div>
                                    <h4 className="font-semibold text-blue-500 mb-2">How AI Trading Works</h4>
                                    <div className="text-sm text-[var(--color-text-secondary)] space-y-2">
                                        <p><strong>When Enabled:</strong></p>
                                        <ul className="list-disc list-inside ml-4 space-y-1">
                                            <li>AI automatically invests your balance if portfolio is empty</li>
                                            <li>Monitors all positions every 5 minutes</li>
                                            <li>Sells automatically if stop-loss (-15%) or take-profit (+30%) triggers</li>
                                            <li>Rebalances portfolio based on AI signals and position drift</li>
                                            <li>Logs all decisions for transparency</li>
                                        </ul>
                                        <p className="mt-3"><strong>View Activity:</strong> Check the <Link href="/ai-trading" className="text-[var(--color-accent)] hover:underline">AI Trading page</Link> to see live status and decision history.</p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Quick Link */}
                        <div className="mt-6 pt-6 border-t border-[var(--color-border)]">
                            <Link 
                                href="/ai-trading"
                                className="inline-block bg-[var(--color-accent)] text-white px-6 py-3 rounded-lg font-semibold hover:opacity-90 transition-opacity"
                            >
                                🤖 Go to AI Trading Dashboard →
                            </Link>
                        </div>
                    </div>
                )}

                {/* AI Trading Section */}
                {activeSection === 'ai' && (
                    <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] p-6">
                        <h2 className="text-xl font-bold text-[var(--color-text-primary)] mb-4">
                            🤖 AI Trading Automation
                        </h2>
                        
                        <div className="bg-blue-500/10 border border-blue-500 rounded-lg p-6 mb-6">
                            <div className="flex items-start">
                                <div className="text-blue-500 text-3xl mr-4">🤖</div>
                                <div className="flex-1">
                                    <h3 className="text-lg font-semibold text-blue-500 mb-2">Fully Automated AI Trading</h3>
                                    <p className="text-sm text-[var(--color-text-secondary)] mb-4">
                                        Enable AI to automatically manage your portfolio 24/7. The AI will invest your balance, monitor positions every 5 minutes, and execute trades based on market signals and risk management rules.
                                    </p>
                                    <ul className="text-sm text-[var(--color-text-secondary)] space-y-2">
                                        <li>✅ <strong>Auto-Initialize:</strong> AI invests your balance across 10 diversified stocks</li>
                                        <li>✅ <strong>Stop-Loss Protection:</strong> Automatically sells if stock drops 15%</li>
                                        <li>✅ <strong>Take-Profit:</strong> Automatically sells when stock gains 30%</li>
                                        <li>✅ <strong>Smart Rebalancing:</strong> Adjusts positions based on AI signals</li>
                                        <li>✅ <strong>24/7 Monitoring:</strong> Checks portfolio every 5 minutes</li>
                                    </ul>
                                </div>
                            </div>
                        </div>

                        {/* Toggle Switch */}
                        <div className="bg-[var(--color-bg-tertiary)] rounded-lg p-6 mb-6">
                            <div className="flex items-center justify-between">
                                <div>
                                    <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-2">
                                        AI Trading Status
                                    </h3>
                                    <p className="text-sm text-[var(--color-text-secondary)]">
                                        {aiTradingEnabled 
                                            ? '🟢 AI is actively managing your portfolio' 
                                            : '⚪ AI trading is currently disabled'}
                                    </p>
                                </div>
                                <button
                                    onClick={handleToggleAITrading}
                                    disabled={aiTradingLoading}
                                    className={`relative inline-flex h-12 w-24 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                                        aiTradingEnabled 
                                            ? 'bg-green-600 focus:ring-green-500' 
                                            : 'bg-gray-300 dark:bg-gray-600 focus:ring-gray-400'
                                    } ${aiTradingLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                                >
                                    <span
                                        className={`inline-block h-10 w-10 transform rounded-full bg-white shadow-lg transition-transform ${
                                            aiTradingEnabled ? 'translate-x-12' : 'translate-x-1'
                                        }`}
                                    />
                                    <span className={`absolute text-xs font-bold ${aiTradingEnabled ? 'left-2 text-white' : 'right-2 text-gray-700 dark:text-gray-300'}`}>
                                        {aiTradingEnabled ? 'ON' : 'OFF'}
                                    </span>
                                </button>
                            </div>
                        </div>

                        {/* AI Strategy Details */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                            <div className="bg-[var(--color-bg-tertiary)] p-4 rounded-lg">
                                <h4 className="font-semibold text-[var(--color-text-primary)] mb-2">📊 Investment Strategy</h4>
                                <ul className="text-sm text-[var(--color-text-secondary)] space-y-1">
                                    <li>• 10% Cash Reserve (Safety)</li>
                                    <li>• Max 20% per Stock (Diversification)</li>
                                    <li>• 10 AI-Selected Stocks</li>
                                    <li>• 5 Sectors Coverage</li>
                                </ul>
                            </div>
                            <div className="bg-[var(--color-bg-tertiary)] p-4 rounded-lg">
                                <h4 className="font-semibold text-[var(--color-text-primary)] mb-2">🛡️ Risk Management</h4>
                                <ul className="text-sm text-[var(--color-text-secondary)] space-y-1">
                                    <li>• Stop-Loss: -15%</li>
                                    <li>• Take-Profit: +30%</li>
                                    <li>• Rebalance: Every 5 min</li>
                                    <li>• Signal-Based Selling</li>
                                </ul>
                            </div>
                        </div>

                        {/* Warning */}
                        {aiTradingEnabled && (
                            <div className="bg-yellow-500/10 border border-yellow-500 rounded-lg p-4">
                                <div className="flex items-start">
                                    <div className="text-yellow-500 text-2xl mr-3">⚠️</div>
                                    <div>
                                        <h4 className="font-semibold text-yellow-500 mb-2">AI Trading Active</h4>
                                        <p className="text-sm text-[var(--color-text-secondary)]">
                                            The AI is now monitoring your portfolio every 5 minutes and will automatically execute trades. 
                                            You can view AI decisions on the <Link href="/ai-trading" className="text-[var(--color-accent)] hover:underline">AI Trading page</Link>.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {!aiTradingEnabled && (
                            <div className="bg-green-500/10 border border-green-500 rounded-lg p-4">
                                <div className="flex items-start">
                                    <div className="text-green-500 text-2xl mr-3">💡</div>
                                    <div>
                                        <h4 className="font-semibold text-green-500 mb-2">Ready to Start?</h4>
                                        <p className="text-sm text-[var(--color-text-secondary)]">
                                            Make sure you have at least $100 in your trading account, then toggle AI Trading ON. 
                                            The AI will automatically invest your balance and start managing your portfolio!
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

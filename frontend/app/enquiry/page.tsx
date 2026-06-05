'use client';

import React, { useState, useEffect, useRef } from 'react';
import { getApiBaseUrl } from '../config';

interface Message {
    id: string;
    type: 'user' | 'assistant';
    content: string;
    timestamp: Date;
    isLoading?: boolean;
}

const Enquiry: React.FC = () => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    // const { showNotification } = useNotifications(); // Not needed for chat interface

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    useEffect(() => {
        // Add welcome message
        setMessages([{
            id: '1',
            type: 'assistant',
            content: `Hello! I'm your KiranRock AI assistant. I can help you with:

• Stock performance analysis
• Market trends and insights
• Portfolio recommendations
• Technical analysis questions
• Trading strategy guidance

Ask me anything about stocks, trading, or market conditions in simple English!

Examples:
- "How is AAPL performing today?"
- "What are the best tech stocks to buy now?"
- "Explain the current market conditions"
- "Should I hold or sell TSLA?"`,
            timestamp: new Date()
        }]);
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;

        const userMessage: Message = {
            id: Date.now().toString(),
            type: 'user',
            content: input.trim(),
            timestamp: new Date()
        };

        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/enquiry`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify({
                    question: userMessage.content
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            const assistantMessage: Message = {
                id: (Date.now() + 1).toString(),
                type: 'assistant',
                content: data.answer || 'Sorry, I couldn\'t process that request.',
                timestamp: new Date()
            };

            setMessages(prev => [...prev, assistantMessage]);

        } catch (error) {
            console.error('Error submitting enquiry:', error);
            // Note: showNotification expects a NewsAlert object, so we'll handle error display in the chat

            const errorMessage: Message = {
                id: (Date.now() + 1).toString(),
                type: 'assistant',
                content: 'Sorry, I\'m having trouble connecting right now. Please check that the Ollama service is running and try again.',
                timestamp: new Date()
            };

            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    };

    const clearChat = () => {
        setMessages([{
            id: '1',
            type: 'assistant',
            content: `Hello! I'm your KiranRock AI assistant. I can help you with:

• Stock performance analysis
• Market trends and insights
• Portfolio recommendations
• Technical analysis questions
• Trading strategy guidance

Ask me anything about stocks, trading, or market conditions in simple English!`,
            timestamp: new Date()
        }]);
    };

    const formatTimestamp = (timestamp: Date) => {
        return timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const sampleQuestions = [
        "How is AAPL performing this week?",
        "What are the top STRONG BUY stocks today?",
        "Explain the current market regime",
        "Should I buy tech stocks now?",
        "What's the VIX telling us about market sentiment?"
    ];

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 pt-16 sm:pt-20">
            <div className="max-w-4xl mx-auto px-4 py-6">
                {/* Header */}
                <div className="mb-6">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-blue-500 rounded-lg">
                                <span className="text-white text-xl">💬</span>
                            </div>
                            <div>
                                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">AI Enquiry</h1>
                                <p className="text-sm text-gray-600 dark:text-gray-400">Ask questions about stocks and market insights</p>
                            </div>
                        </div>
                        <button
                            onClick={clearChat}
                            className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                        >
                            Clear Chat
                        </button>
                    </div>

                    {/* Sample Questions */}
                    <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Try these questions (natural language supported):</p>
                        <div className="flex flex-wrap gap-2">
                            {sampleQuestions.map((question, index) => (
                                <button
                                    key={index}
                                    onClick={() => setInput(question)}
                                    className="text-xs px-3 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
                                >
                                    {question}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Chat Messages */}
                <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 flex flex-col h-[calc(100vh-300px)] min-h-[400px]">
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                        {messages.map((message) => (
                            <div
                                key={message.id}
                                className={`flex ${message.type === 'user' ? 'justify-end' : 'justify-start'}`}
                            >
                                <div className={`max-w-3xl ${message.type === 'user' ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-white'} rounded-lg p-3 shadow-sm`}>
                                    <div className="whitespace-pre-wrap text-sm leading-relaxed">
                                        {message.content}
                                    </div>
                                    <div className={`text-xs mt-2 ${message.type === 'user' ? 'text-blue-100' : 'text-gray-500 dark:text-gray-400'}`}>
                                        {formatTimestamp(message.timestamp)}
                                    </div>
                                </div>
                            </div>
                        ))}
                        {isLoading && (
                            <div className="flex justify-start">
                                <div className="bg-gray-100 dark:bg-gray-700 rounded-lg p-3 shadow-sm">
                                    <div className="flex items-center space-x-2">
                                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500"></div>
                                        <span className="text-sm text-gray-600 dark:text-gray-400">Thinking...</span>
                                    </div>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input Form */}
                    <div className="border-t border-gray-200 dark:border-gray-700 p-4">
                        <form onSubmit={handleSubmit} className="flex gap-2">
                            <input
                                type="text"
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                placeholder="Ask me about stocks, market trends, or trading strategies..."
                                className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
                                disabled={isLoading}
                            />
                            <button
                                type="submit"
                                disabled={isLoading || !input.trim()}
                                className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                            >
                                {isLoading ? 'Sending...' : 'Send'}
                            </button>
                        </form>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                            Powered by local Ollama AI • Data stays private
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Enquiry;
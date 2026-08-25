'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './auth-context';

interface SocketContextType {
  socket: Socket | null;
  connected: boolean;
}

const SocketContext = createContext<SocketContextType>({ socket: null, connected: false });

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Only connect when the user is authenticated (token cookie will be present)
    if (!user) {
      // Disconnect any existing socket when user logs out
      if (socket) {
        socket.close();
        setTimeout(() => {
          setSocket(null);
          setConnected(false);
        }, 0);
      }
      return;
    }

    // If socket already exists and is connected, skip
    if (socket?.connected) return;

    const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
    const socketUrl = typeof window !== 'undefined' 
      ? new URL(baseUrl, window.location.href).origin 
      : baseUrl;
    const socketIo = io(socketUrl, {
      withCredentials: true,
      transports: ['websocket', 'polling']
    });

    socketIo.on('connect', () => {
      console.log('Socket connected with ID:', socketIo.id);
      setConnected(true);
    });

    socketIo.on('disconnect', () => {
      console.log('Socket disconnected');
      setConnected(false);
    });

    socketIo.on('connect_error', (error) => {
      console.error('Socket connect_error:', error);
    });

    setSocket(socketIo);

    return () => {
      console.log('Closing socket context connection');
      socketIo.close();
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SocketContext.Provider value={{ socket, connected }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}

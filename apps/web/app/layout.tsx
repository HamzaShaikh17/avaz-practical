import type { Metadata } from 'next';
import './globals.css';
import { BackgroundSyncProvider } from './providers';

export const metadata: Metadata = {
  title: 'session-replay',
  description: 'session-replay web app',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <BackgroundSyncProvider>{children}</BackgroundSyncProvider>
      </body>
    </html>
  );
}

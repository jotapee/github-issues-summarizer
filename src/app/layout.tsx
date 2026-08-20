import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Repo Health Check: is this project maintained?',
  description:
    'Paste a GitHub repository URL to get a maintenance health score and a short briefing on what its open issues actually say.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

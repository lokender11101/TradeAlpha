# Frontend Information Architecture

The frontend is built with Next.js, emphasizing a premium, professional, data-dense financial aesthetic.

## 1. Core Principles
- **Minimalism & Precision**: No excessive rounded corners, generic dashboards, or unnecessary animations.
- **Data-Dense Layouts**: Financial users want information density. Use high-quality typography (e.g., Inter or Roboto Mono for numbers) and clear tabular structures.
- **Performance**: Instantaneous navigation. Server-side rendering for SEO/initial load, Client-side transitions for the App feel.

## 2. Route Structure
- `/` - Landing Page (Value prop, premium feel)
- `/login` / `/register` - Authentication
- `/dashboard` - Main Dashboard (High-level portfolio summary)
- `/markets` - Market overview (Indices, top movers)
- `/stocks/[symbol]` - Detailed equity analysis & trading terminal
- `/portfolio` - Deep dive into portfolio metrics (Realized/Unrealized P&L)
- `/positions` - Tabular view of all open positions
- `/orders` - Order history and pending cancellations
- `/watchlists` - Custom curated lists

## 3. Component System
- **Typography**: Strictly tracked letter-spacing. Tabular numerals for all financial figures.
- **Colors**: Dark mode by default. Muted, precise colors. No neon glowing borders. Red/Green used exclusively for financial up/down indicators.
- **Charts**: Lightweight Charts library for performant, interactive candlestick and line charts.
- **State Management**: TanStack Query for caching API data, React Context/Zustand for WebSocket data.

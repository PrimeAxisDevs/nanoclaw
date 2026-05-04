---
name: xauusd
description: XAUUSD (Gold/USD) technical analysis. Fetches live market data via yfinance and runs multi-timeframe analysis with signals, key levels, and trade setups. Also manages the trade journal for logging and reviewing paper trades.
allowed-tools: Bash(python3 /home/node/.claude/skills/xauusd/analyze.py:*), Bash(python3 /home/node/.claude/skills/xauusd/journal.py:*)
---

# XAUUSD Trading Analysis

Use these tools to analyze Gold/USD and manage your paper trading journal.

## Market Analysis

```bash
# Full multi-timeframe analysis (default)
python3 /home/node/.claude/skills/xauusd/analyze.py

# Specific timeframe: 1h, 4h, 1d
python3 /home/node/.claude/skills/xauusd/analyze.py --timeframe 4h

# Quick signal only (faster)
python3 /home/node/.claude/skills/xauusd/analyze.py --quick

# Raw JSON output (for scripting)
python3 /home/node/.claude/skills/xauusd/analyze.py --json
```

Output includes:
- Current price + 24h change
- Signal: BUY / SELL / NEUTRAL + confidence %
- Multi-timeframe bias (D1, H4, H1)
- EMA stack, RSI, MACD, ATR, Bollinger Bands
- Key support/resistance levels
- Suggested entry, stop loss, take profit (1:1, 1:2, 1:3 RR)
- Active trading session (London/NY overlap = prime time)

## Trade Journal

```bash
# Open a new paper trade
python3 /home/node/.claude/skills/xauusd/journal.py open --direction long --entry 2450.50 --sl 2440.00 --tp 2465.00 --notes "H1 EMA bounce"

# Close a trade (win/loss/break_even)
python3 /home/node/.claude/skills/xauusd/journal.py close --id TRADE_ID --exit 2462.00 --outcome win

# List open trades
python3 /home/node/.claude/skills/xauusd/journal.py list

# Performance stats (win rate, avg RR, best patterns)
python3 /home/node/.claude/skills/xauusd/journal.py stats

# Full trade history
python3 /home/node/.claude/skills/xauusd/journal.py history --limit 20
```

## Chart Image Analysis

When the user sends a TradingView screenshot, analyze it with Claude's vision and:
1. Identify trend direction (higher highs/lows or lower highs/lows)
2. Note key support/resistance levels visible on chart
3. Read indicator values if visible (RSI, MACD, EMAs)
4. Identify chart patterns (head & shoulders, triangles, flags, etc.)
5. Give a clear Bullish / Bearish / Neutral verdict with reasoning
6. Suggest entry zone, stop loss, and take profit targets

Then run `analyze.py` to cross-check with live data before giving a final recommendation.

## Trading Sessions (UTC)

| Session | Hours UTC | Notes |
|---------|-----------|-------|
| Asian | 00:00–09:00 | Low volatility for Gold |
| London | 08:00–17:00 | Good Gold movement |
| New York | 13:00–22:00 | High volatility |
| **London/NY Overlap** | **13:00–17:00** | **Prime time — highest liquidity** |

## Learning Protocol

After each closed trade, the journal records:
- Signal source (image analysis / scheduled scan / manual)
- Which indicators confirmed the signal
- Session at entry
- Outcome (win/loss/break-even) and actual RR achieved

Run `journal.py stats` weekly to identify your highest-probability setups.

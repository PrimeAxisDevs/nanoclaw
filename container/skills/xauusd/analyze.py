#!/usr/bin/env python3
"""
XAUUSD Technical Analysis
Fetches Gold/USD data via yfinance and runs multi-timeframe TA.
"""

import argparse
import json
import sys
import warnings
from datetime import datetime, timezone

warnings.filterwarnings("ignore")

try:
    import yfinance as yf
    import pandas as pd
    import numpy as np
except ImportError as e:
    print(json.dumps({"error": f"Missing dependency: {e}. Run: pip3 install yfinance pandas numpy"}))
    sys.exit(1)

try:
    import ta
except ImportError:
    ta = None  # fallback to manual calcs

SYMBOL = "GC=F"  # COMEX Gold Futures — most reliable yfinance source for gold


def get_session() -> dict:
    """Return current trading session info (UTC)."""
    now_utc = datetime.now(timezone.utc)
    hour = now_utc.hour
    weekday = now_utc.weekday()  # 0=Mon, 6=Sun

    if weekday >= 5:
        return {"current": "Market Closed (Weekend)", "active": [], "prime_time": False}

    sessions = []
    if 0 <= hour < 9:
        sessions.append("Asian")
    if 8 <= hour < 17:
        sessions.append("London")
    if 13 <= hour < 22:
        sessions.append("New York")
    if not sessions:
        sessions.append("Asian")

    prime_time = "London" in sessions and "New York" in sessions

    if prime_time:
        current = "London/NY Overlap (Prime Time)"
    elif len(sessions) == 1:
        current = f"{sessions[0]} Session"
    else:
        current = " + ".join(sessions) + " Session"

    return {"current": current, "active": sessions, "prime_time": prime_time}


def fetch_data(interval: str, period: str) -> "pd.DataFrame | None":
    """Fetch OHLCV data from yfinance."""
    try:
        ticker = yf.Ticker(SYMBOL)
        df = ticker.history(interval=interval, period=period, auto_adjust=True)
        if df is None or df.empty:
            return None
        df.index = pd.to_datetime(df.index, utc=True)
        return df
    except Exception:
        return None


def resample_4h(df_1h: "pd.DataFrame") -> "pd.DataFrame":
    """Resample 1h data into 4h candles."""
    df = df_1h.resample("4h").agg({
        "Open": "first",
        "High": "max",
        "Low": "min",
        "Close": "last",
        "Volume": "sum"
    }).dropna()
    return df


def ema(series: "pd.Series", period: int) -> "pd.Series":
    return series.ewm(span=period, adjust=False).mean()


def rsi(series: "pd.Series", period: int = 14) -> float:
    """Calculate RSI."""
    if ta:
        r = ta.momentum.RSIIndicator(series, window=period).rsi()
        return round(float(r.iloc[-1]), 1)
    # Manual RSI
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1/period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi_series = 100 - (100 / (1 + rs))
    return round(float(rsi_series.iloc[-1]), 1)


def macd(series: "pd.Series", fast: int = 12, slow: int = 26, signal_period: int = 9) -> tuple:
    """Returns (macd_line, signal_line, histogram)."""
    if ta:
        m = ta.trend.MACD(series, window_fast=fast, window_slow=slow, window_sign=signal_period)
        return (
            round(float(m.macd().iloc[-1]), 3),
            round(float(m.macd_signal().iloc[-1]), 3),
            round(float(m.macd_diff().iloc[-1]), 3),
        )
    fast_ema = ema(series, fast)
    slow_ema = ema(series, slow)
    macd_line = fast_ema - slow_ema
    signal_line = ema(macd_line, signal_period)
    hist = macd_line - signal_line
    return (
        round(float(macd_line.iloc[-1]), 3),
        round(float(signal_line.iloc[-1]), 3),
        round(float(hist.iloc[-1]), 3),
    )


def atr(high: "pd.Series", low: "pd.Series", close: "pd.Series", period: int = 14) -> float:
    """Average True Range."""
    if ta:
        a = ta.volatility.AverageTrueRange(high, low, close, window=period).average_true_range()
        return round(float(a.iloc[-1]), 2)
    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low - close.shift()).abs(),
    ], axis=1).max(axis=1)
    atr_series = tr.ewm(alpha=1/period, adjust=False).mean()
    return round(float(atr_series.iloc[-1]), 2)


def bollinger(series: "pd.Series", period: int = 20, std: float = 2.0) -> tuple:
    """Returns (lower, mid, upper)."""
    mid = series.rolling(period).mean()
    std_dev = series.rolling(period).std()
    return (
        round(float((mid - std * std_dev).iloc[-1]), 2),
        round(float(mid.iloc[-1]), 2),
        round(float((mid + std * std_dev).iloc[-1]), 2),
    )


def stochastic(high: "pd.Series", low: "pd.Series", close: "pd.Series", k: int = 14, d: int = 3) -> tuple:
    """Returns (stoch_k, stoch_d)."""
    if ta:
        s = ta.momentum.StochasticOscillator(high, low, close, window=k, smooth_window=d)
        return round(float(s.stoch().iloc[-1]), 1), round(float(s.stoch_signal().iloc[-1]), 1)
    lowest_low = low.rolling(k).min()
    highest_high = high.rolling(k).max()
    stoch_k = 100 * (close - lowest_low) / (highest_high - lowest_low + 1e-10)
    stoch_d = stoch_k.rolling(d).mean()
    return round(float(stoch_k.iloc[-1]), 1), round(float(stoch_d.iloc[-1]), 1)


def calc_indicators(df: "pd.DataFrame") -> dict:
    """Calculate all technical indicators."""
    if len(df) < 50:
        return {}

    close = df["Close"]
    high = df["High"]
    low = df["Low"]
    close_val = float(close.iloc[-1])

    result: dict = {}

    # EMAs
    for period in [9, 21, 50, 200]:
        e = ema(close, period)
        result[f"ema{period}"] = round(float(e.iloc[-1]), 2)

    # RSI
    result["rsi"] = rsi(close)

    # MACD
    result["macd"], result["macd_signal"], result["macd_hist"] = macd(close)

    # ATR
    result["atr14"] = atr(high, low, close)

    # Bollinger
    result["bb_lower"], result["bb_mid"], result["bb_upper"] = bollinger(close)

    # Stochastic
    result["stoch_k"], result["stoch_d"] = stochastic(high, low, close)

    return result


def get_trend(ind: dict, close: float) -> str:
    """Determine trend direction from EMA alignment."""
    emas = [ind.get(f"ema{p}") for p in [9, 21, 50, 200]]
    if None in emas or len([e for e in emas if e]) < 4:
        return "UNKNOWN"
    if emas[0] > emas[1] > emas[2] > emas[3] and close > emas[0]:
        return "STRONG BULLISH"
    elif emas[0] > emas[1] > emas[2]:
        return "BULLISH"
    elif emas[0] < emas[1] < emas[2] < emas[3] and close < emas[0]:
        return "STRONG BEARISH"
    elif emas[0] < emas[1] < emas[2]:
        return "BEARISH"
    else:
        return "RANGING"


def get_sr_levels(df: "pd.DataFrame", n_levels: int = 3) -> dict:
    """Find support/resistance via pivot points and swing highs/lows."""
    close = float(df["Close"].iloc[-1])

    # Classic pivot points from last completed candle
    prev = df.iloc[-2]
    pivot = (float(prev["High"]) + float(prev["Low"]) + float(prev["Close"])) / 3
    r1 = round(2 * pivot - float(prev["Low"]), 2)
    r2 = round(pivot + (float(prev["High"]) - float(prev["Low"])), 2)
    r3 = round(float(prev["High"]) + 2 * (pivot - float(prev["Low"])), 2)
    s1 = round(2 * pivot - float(prev["High"]), 2)
    s2 = round(pivot - (float(prev["High"]) - float(prev["Low"])), 2)
    s3 = round(float(prev["Low"]) - 2 * (float(prev["High"]) - pivot), 2)

    # Swing highs/lows over last 50 candles
    window = min(50, len(df))
    high_arr = df["High"].tail(window).values
    low_arr = df["Low"].tail(window).values

    swing_highs = []
    swing_lows = []
    for i in range(2, len(high_arr) - 2):
        if high_arr[i] > high_arr[i-1] and high_arr[i] > high_arr[i-2] and \
           high_arr[i] > high_arr[i+1] and high_arr[i] > high_arr[i+2]:
            swing_highs.append(round(float(high_arr[i]), 2))
        if low_arr[i] < low_arr[i-1] and low_arr[i] < low_arr[i-2] and \
           low_arr[i] < low_arr[i+1] and low_arr[i] < low_arr[i+2]:
            swing_lows.append(round(float(low_arr[i]), 2))

    resistances = sorted(set(swing_highs + [r1, r2, r3]))
    supports = sorted(set(swing_lows + [s1, s2, s3]))

    # Only keep levels above/below current price, nearest first
    resistances = sorted([l for l in resistances if l > close * 1.001])[:n_levels]
    supports = sorted([l for l in supports if l < close * 0.999], reverse=True)[:n_levels]

    return {"pivot": round(pivot, 2), "resistance": resistances, "support": supports}


def score_timeframe(ind: dict, trend: str) -> int:
    """Score a timeframe bullish (+) or bearish (-)."""
    score = 0
    if "BULLISH" in trend:
        score += 2 if "STRONG" in trend else 1
    elif "BEARISH" in trend:
        score -= 2 if "STRONG" in trend else 1

    rsi_val = ind.get("rsi")
    if rsi_val is not None:
        if rsi_val > 55:
            score += 1
        elif rsi_val < 45:
            score -= 1
        if rsi_val > 75:
            score -= 1  # overbought penalty
        elif rsi_val < 25:
            score += 1  # oversold bonus

    hist = ind.get("macd_hist")
    if hist is not None:
        score += 1 if hist > 0 else -1

    return score


def build_trade_setup(close: float, ind: dict, signal: str, sr: dict) -> dict:
    """Calculate entry, SL, TP from ATR and key levels."""
    atr_val = ind.get("atr14") or (close * 0.005)

    if signal == "BUY":
        entry = close
        sl = round(close - 1.5 * atr_val, 2)
        resistances = sr.get("resistance", [])
        tp1 = resistances[0] if resistances else round(close + atr_val, 2)
        tp2 = round(close + 2.0 * atr_val, 2)
        tp3 = round(close + 3.0 * atr_val, 2)
    elif signal == "SELL":
        entry = close
        sl = round(close + 1.5 * atr_val, 2)
        supports = sr.get("support", [])
        tp1 = supports[0] if supports else round(close - atr_val, 2)
        tp2 = round(close - 2.0 * atr_val, 2)
        tp3 = round(close - 3.0 * atr_val, 2)
    else:
        return {}

    risk = abs(entry - sl)
    rr = round(abs(tp2 - entry) / risk, 1) if risk > 0 else 0

    return {
        "entry": round(entry, 2),
        "stop_loss": sl,
        "take_profit_1": tp1,
        "take_profit_2": tp2,
        "take_profit_3": tp3,
        "risk_pips": round(risk, 2),
        "risk_reward": rr,
    }


def format_text(data: dict) -> str:
    """Format analysis as a readable WhatsApp message."""
    p = data["price"]
    sig = data["signal"]
    conf = data["confidence"]
    session = data["session"]["current"]
    ind = data["indicators"].get("H1", {})
    sr = data["key_levels"]
    setup = data.get("trade_setup", {})
    tf = data["timeframe_bias"]

    emoji_sig = "🟢" if sig == "BUY" else ("🔴" if sig == "SELL" else "🟡")
    prime = " ⚡" if data["session"]["prime_time"] else ""

    lines = [
        f"*XAUUSD Analysis* — {datetime.now(timezone.utc).strftime('%H:%M UTC')}",
        f"💰 Price: *${p['current']:,.2f}* ({p['change_pct_24h']:+.2f}% 24h)",
        f"",
        f"{emoji_sig} Signal: *{sig}* ({conf}% confidence){prime}",
        f"📍 Session: {session}",
        f"",
        f"*Multi-Timeframe Bias*",
        f"• D1: {tf.get('D1', {}).get('trend', 'N/A')}",
        f"• H4: {tf.get('H4', {}).get('trend', 'N/A')}",
        f"• H1: {tf.get('H1', {}).get('trend', 'N/A')}",
        f"",
        f"*H1 Indicators*",
    ]

    if ind.get("rsi") is not None:
        rsi_label = "Overbought" if ind["rsi"] > 70 else ("Oversold" if ind["rsi"] < 30 else "Neutral")
        lines.append(f"• RSI(14): {ind['rsi']} — {rsi_label}")
    if ind.get("macd_hist") is not None:
        direction = "↑" if ind["macd_hist"] > 0 else "↓"
        lines.append(f"• MACD Hist: {ind['macd_hist']:+.3f} {direction}")
    if ind.get("atr14") is not None:
        lines.append(f"• ATR(14): ${ind['atr14']:.2f}")
    if ind.get("ema9") and ind.get("ema21"):
        lines.append(f"• EMA 9/21: {ind['ema9']:.2f} / {ind['ema21']:.2f}")

    if sr.get("resistance"):
        lines.extend([
            "",
            f"*Key Levels*",
            f"• Resistance: {' | '.join(f'${r:,.2f}' for r in sr['resistance'])}",
            f"• Support: {' | '.join(f'${s:,.2f}' for s in sr['support'])}",
        ])

    if setup:
        lines.extend([
            "",
            f"*Trade Setup*",
            f"• Entry: ${setup['entry']:,.2f}",
            f"• Stop Loss: ${setup['stop_loss']:,.2f} ({setup['risk_pips']:.2f} pts risk)",
            f"• TP1: ${setup['take_profit_1']:,.2f}",
            f"• TP2: ${setup['take_profit_2']:,.2f} (RR {setup['risk_reward']}:1)",
            f"• TP3: ${setup['take_profit_3']:,.2f}",
        ])

    lines.append("")
    lines.append("_Data: yfinance (15-min delay) | Paper trading only_")

    return "\n".join(lines)


def analyze(quick: bool = False) -> dict:
    """Run full multi-timeframe analysis."""
    df_1h = fetch_data("1h", "60d")
    if df_1h is None or df_1h.empty:
        return {"error": "Failed to fetch XAUUSD data. Markets may be closed or API unavailable."}

    df_4h = resample_4h(df_1h)
    df_1d = fetch_data("1d", "1y") if not quick else None

    latest = df_1h.iloc[-1]
    close = float(latest["Close"])
    open_24h = float(df_1h["Open"].iloc[-24]) if len(df_1h) >= 24 else float(latest["Open"])
    high_24h = float(df_1h["High"].tail(24).max())
    low_24h = float(df_1h["Low"].tail(24).min())
    change_24h = close - open_24h
    change_pct = (change_24h / open_24h) * 100 if open_24h > 0 else 0

    ind_1h = calc_indicators(df_1h)
    ind_4h = calc_indicators(df_4h)
    ind_1d = calc_indicators(df_1d) if df_1d is not None else {}

    trend_1h = get_trend(ind_1h, close)
    trend_4h = get_trend(ind_4h, close)
    trend_1d = get_trend(ind_1d, close) if ind_1d else "N/A"

    score = 0
    score += score_timeframe(ind_1h, trend_1h) * 1
    score += score_timeframe(ind_4h, trend_4h) * 2
    if ind_1d:
        score += score_timeframe(ind_1d, trend_1d) * 3

    max_score = 4 * (1 + 2 + (3 if ind_1d else 0))
    confidence = min(95, max(5, int(abs(score) / max_score * 100))) if max_score > 0 else 50

    if score >= 2:
        signal = "BUY"
    elif score <= -2:
        signal = "SELL"
    else:
        signal = "NEUTRAL"
        confidence = max(5, 50 - confidence)

    sr = get_sr_levels(df_1h)
    setup = build_trade_setup(close, ind_1h, signal, sr) if signal != "NEUTRAL" else {}

    return {
        "symbol": "XAUUSD",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "price": {
            "current": round(close, 2),
            "open_24h": round(open_24h, 2),
            "high_24h": round(high_24h, 2),
            "low_24h": round(low_24h, 2),
            "change_24h": round(change_24h, 2),
            "change_pct_24h": round(change_pct, 2),
        },
        "signal": signal,
        "confidence": confidence,
        "score": score,
        "session": get_session(),
        "timeframe_bias": {
            "H1": {"trend": trend_1h, "rsi": ind_1h.get("rsi"), "macd_hist": ind_1h.get("macd_hist")},
            "H4": {"trend": trend_4h, "rsi": ind_4h.get("rsi"), "macd_hist": ind_4h.get("macd_hist")},
            "D1": {"trend": trend_1d, "rsi": ind_1d.get("rsi"), "macd_hist": ind_1d.get("macd_hist")} if ind_1d else {"trend": "N/A"},
        },
        "indicators": {
            "H1": ind_1h,
            "H4": ind_4h,
            "D1": ind_1d if ind_1d else {},
        },
        "key_levels": sr,
        "trade_setup": setup,
    }


def main():
    parser = argparse.ArgumentParser(description="XAUUSD Technical Analysis")
    parser.add_argument("--timeframe", choices=["1h", "4h", "1d"], default="1h")
    parser.add_argument("--quick", action="store_true", help="Skip D1 timeframe (faster)")
    parser.add_argument("--json", action="store_true", help="Output raw JSON")
    args = parser.parse_args()

    data = analyze(quick=args.quick)

    if "error" in data:
        if args.json:
            print(json.dumps(data))
        else:
            print(f"Error: {data['error']}")
        sys.exit(1)

    if args.json:
        print(json.dumps(data, indent=2))
    else:
        print(format_text(data))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
XAUUSD Paper Trade Journal
Logs, tracks, and reviews paper trades. Stores in SQLite at /workspace/group/trades.db
"""

import argparse
import json
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone

DB_PATH = os.environ.get("XAUUSD_DB", "/workspace/group/trades.db")


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS trades (
            id TEXT PRIMARY KEY,
            symbol TEXT NOT NULL DEFAULT 'XAUUSD',
            direction TEXT NOT NULL,
            entry_price REAL NOT NULL,
            exit_price REAL,
            stop_loss REAL NOT NULL,
            take_profit REAL,
            pnl_pips REAL,
            pnl_usd REAL,
            lot_size REAL DEFAULT 0.01,
            entry_time TEXT NOT NULL,
            exit_time TEXT,
            duration_minutes INTEGER,
            outcome TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            signal_source TEXT DEFAULT 'manual',
            session TEXT,
            indicators TEXT,
            notes TEXT,
            created_at TEXT NOT NULL
        )
    """)
    conn.commit()
    return conn


def cmd_open(args) -> None:
    conn = get_db()
    trade_id = str(uuid.uuid4())[:8].upper()
    now = datetime.now(timezone.utc).isoformat()

    # Detect current session
    hour = datetime.now(timezone.utc).hour
    sessions = []
    if 8 <= hour < 17:
        sessions.append("London")
    if 13 <= hour < 22:
        sessions.append("New York")
    if not sessions:
        sessions.append("Asian")
    session = "/".join(sessions)

    conn.execute("""
        INSERT INTO trades (id, direction, entry_price, stop_loss, take_profit,
                           lot_size, entry_time, status, signal_source, session, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
    """, (
        trade_id,
        args.direction.upper(),
        args.entry,
        args.sl,
        args.tp,
        args.lots if hasattr(args, 'lots') and args.lots else 0.01,
        now,
        args.source if hasattr(args, 'source') and args.source else "manual",
        session,
        args.notes if hasattr(args, 'notes') and args.notes else None,
        now,
    ))
    conn.commit()

    risk_pips = abs(args.entry - args.sl)
    reward_pips = abs(args.tp - args.entry) if args.tp else None
    rr = round(reward_pips / risk_pips, 1) if reward_pips and risk_pips > 0 else None

    print(f"Trade opened: *{trade_id}*")
    print(f"• {args.direction.upper()} XAUUSD @ ${args.entry:,.2f}")
    print(f"• SL: ${args.sl:,.2f} | TP: ${args.tp:,.2f}" if args.tp else f"• SL: ${args.sl:,.2f}")
    if rr:
        print(f"• Risk: {risk_pips:.2f} pts | RR: {rr}:1")
    print(f"• Session: {session}")
    print(f"• ID: {trade_id}")


def cmd_close(args) -> None:
    conn = get_db()
    row = conn.execute("SELECT * FROM trades WHERE id = ? AND status = 'open'", (args.id,)).fetchone()

    if not row:
        print(f"No open trade found with ID: {args.id}")
        sys.exit(1)

    now = datetime.now(timezone.utc).isoformat()
    entry_dt = datetime.fromisoformat(row["entry_time"])
    exit_dt = datetime.now(timezone.utc)
    duration = int((exit_dt - entry_dt).total_seconds() / 60)

    direction = row["direction"]
    entry = row["entry_price"]
    exit_price = args.exit

    if direction == "LONG":
        pnl_pips = exit_price - entry
    else:
        pnl_pips = entry - exit_price

    # Rough USD PnL assuming 0.01 lot = $0.01/pip for XAUUSD (1 pip = $0.01)
    # Actually for XAUUSD: 1 lot = 100 oz, so 0.01 lot = 1 oz, $1/pip movement
    lot_size = row["lot_size"] or 0.01
    pnl_usd = round(pnl_pips * lot_size * 100, 2)

    outcome = args.outcome.lower() if hasattr(args, 'outcome') and args.outcome else (
        "win" if pnl_pips > 0 else "loss" if pnl_pips < 0 else "break_even"
    )

    conn.execute("""
        UPDATE trades SET
            exit_price = ?, exit_time = ?, duration_minutes = ?,
            pnl_pips = ?, pnl_usd = ?, outcome = ?, status = 'closed'
        WHERE id = ?
    """, (exit_price, now, duration, round(pnl_pips, 2), pnl_usd, outcome, args.id))
    conn.commit()

    emoji = "✅" if outcome == "win" else ("❌" if outcome == "loss" else "➖")
    print(f"{emoji} Trade closed: *{args.id}*")
    print(f"• Entry: ${entry:,.2f} → Exit: ${exit_price:,.2f}")
    print(f"• P&L: {pnl_pips:+.2f} pips | ${pnl_usd:+.2f}")
    print(f"• Duration: {duration} minutes")
    print(f"• Outcome: {outcome.upper()}")


def cmd_list(args) -> None:
    conn = get_db()
    trades = conn.execute(
        "SELECT * FROM trades WHERE status = 'open' ORDER BY entry_time DESC"
    ).fetchall()

    if not trades:
        print("No open trades.")
        return

    print(f"*Open Trades ({len(trades)})*")
    for t in trades:
        print(f"• [{t['id']}] {t['direction']} @ ${t['entry_price']:,.2f} | SL: ${t['stop_loss']:,.2f} | {t['session']}")


def cmd_history(args) -> None:
    conn = get_db()
    limit = args.limit if hasattr(args, 'limit') and args.limit else 20
    trades = conn.execute(
        "SELECT * FROM trades WHERE status = 'closed' ORDER BY exit_time DESC LIMIT ?",
        (limit,)
    ).fetchall()

    if not trades:
        print("No closed trades yet.")
        return

    print(f"*Last {len(trades)} Closed Trades*")
    for t in trades:
        emoji = "✅" if t["outcome"] == "win" else ("❌" if t["outcome"] == "loss" else "➖")
        pnl = t["pnl_pips"] or 0
        print(f"{emoji} [{t['id']}] {t['direction']} | {pnl:+.2f} pips | {t['session'] or 'N/A'} | {(t['exit_time'] or '')[:10]}")


def cmd_stats(args) -> None:
    conn = get_db()
    closed = conn.execute(
        "SELECT * FROM trades WHERE status = 'closed'"
    ).fetchall()

    if not closed:
        print("No closed trades yet. Open and close some paper trades to see stats.")
        return

    total = len(closed)
    wins = sum(1 for t in closed if t["outcome"] == "win")
    losses = sum(1 for t in closed if t["outcome"] == "loss")
    breakeven = total - wins - losses

    win_rate = round((wins / total) * 100, 1) if total > 0 else 0

    pnl_values = [t["pnl_pips"] for t in closed if t["pnl_pips"] is not None]
    total_pnl = round(sum(pnl_values), 2)
    avg_win = round(sum(p for p in pnl_values if p > 0) / wins, 2) if wins > 0 else 0
    avg_loss = round(sum(p for p in pnl_values if p < 0) / losses, 2) if losses > 0 else 0
    profit_factor = round(abs(avg_win * wins) / abs(avg_loss * losses), 2) if losses > 0 and avg_loss != 0 else float("inf")

    # Best/worst trades
    best = max(closed, key=lambda t: t["pnl_pips"] or -99999)
    worst = min(closed, key=lambda t: t["pnl_pips"] or 99999)

    # Session breakdown
    session_stats: dict = {}
    for t in closed:
        sess = t["session"] or "Unknown"
        if sess not in session_stats:
            session_stats[sess] = {"wins": 0, "losses": 0}
        if t["outcome"] == "win":
            session_stats[sess]["wins"] += 1
        elif t["outcome"] == "loss":
            session_stats[sess]["losses"] += 1

    print(f"*XAUUSD Paper Trading Stats*")
    print(f"")
    print(f"Total trades: {total} | Wins: {wins} | Losses: {losses} | BE: {breakeven}")
    print(f"Win Rate: *{win_rate}%*")
    print(f"Total P&L: {total_pnl:+.2f} pips")
    print(f"Avg Win: {avg_win:+.2f} | Avg Loss: {avg_loss:+.2f}")
    print(f"Profit Factor: {profit_factor}")
    print(f"")
    print(f"*Best trade:* [{best['id']}] {(best['pnl_pips'] or 0):+.2f} pips")
    print(f"*Worst trade:* [{worst['id']}] {(worst['pnl_pips'] or 0):+.2f} pips")

    if session_stats:
        print(f"")
        print(f"*By Session:*")
        for sess, s in sorted(session_stats.items(), key=lambda x: x[1]["wins"], reverse=True):
            sess_total = s["wins"] + s["losses"]
            sess_wr = round((s["wins"] / sess_total) * 100, 0) if sess_total > 0 else 0
            print(f"• {sess}: {sess_wr}% WR ({s['wins']}W / {s['losses']}L)")


def main():
    parser = argparse.ArgumentParser(description="XAUUSD Trade Journal")
    subs = parser.add_subparsers(dest="command")

    # open
    p_open = subs.add_parser("open", help="Open a paper trade")
    p_open.add_argument("--direction", required=True, choices=["long", "short", "LONG", "SHORT"])
    p_open.add_argument("--entry", required=True, type=float)
    p_open.add_argument("--sl", required=True, type=float, help="Stop loss price")
    p_open.add_argument("--tp", type=float, help="Take profit price")
    p_open.add_argument("--lots", type=float, default=0.01)
    p_open.add_argument("--source", default="manual", help="Signal source")
    p_open.add_argument("--notes", default="", help="Trade notes")

    # close
    p_close = subs.add_parser("close", help="Close a paper trade")
    p_close.add_argument("--id", required=True, help="Trade ID")
    p_close.add_argument("--exit", required=True, type=float, dest="exit", help="Exit price")
    p_close.add_argument("--outcome", choices=["win", "loss", "break_even"])

    # list
    subs.add_parser("list", help="List open trades")

    # history
    p_hist = subs.add_parser("history", help="View closed trade history")
    p_hist.add_argument("--limit", type=int, default=20)

    # stats
    subs.add_parser("stats", help="Performance statistics")

    args = parser.parse_args()

    if args.command == "open":
        cmd_open(args)
    elif args.command == "close":
        cmd_close(args)
    elif args.command == "list":
        cmd_list(args)
    elif args.command == "history":
        cmd_history(args)
    elif args.command == "stats":
        cmd_stats(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

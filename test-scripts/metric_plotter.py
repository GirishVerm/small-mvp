"""Plot analytics metrics over time."""

import sqlite3
import matplotlib.pyplot as plt
from collections import defaultdict
from datetime import datetime, timedelta


DB_PATH = "data/analytics.db"


def get_daily_error_rates():
    """Fetch daily error rates from session metrics."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    query = """
        SELECT DATE(s.created_at) as day, AVG(m.error_rate) as avg_error_rate
        FROM session_metrics m
        JOIN sessions s ON m.session_id = s.id
        GROUP BY DATE(s.created_at)
        ORDER BY day
    """
    cursor = conn.execute(query)
    rows = cursor.fetchall()
    conn.close()

    days = [row["day"] for row in rows]
    rates = [row["avg_error_rate"] for row in rows]
    return days, rates


def get_health_distribution():
    """Calculate health label distribution across sessions."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    query = "SELECT error_rate, edit_success_rate FROM session_metrics"
    cursor = conn.execute(query)
    rows = cursor.fetchall()
    conn.close()

    distribution = {"smooth": 0, "friction": 0, "struggling": 0}

    for row in rows:
        er = row["error_rate"]
        esr = row["edit_success_rate"]
        if er > 0.3 or esr < 0.5:
            distribution["struggling"] += 1
        elif er >= 0.1 or esr <= 0.8:
            distribution["friction"] += 1
        else:
            distribution["smooth"] += 1

    return distribution


def plot_error_trend():
    """Plot error rate trend over time."""
    days, rates = get_daily_error_rates()

    if not days:
        print("No data to plot")
        return

    fig, ax = plt.subplots(figsize=(12, 6))
    ax.plot(days, rates, marker="o", linewidth=2, color="#2196F3")
    ax.fill_between(days, rates, alpha=0.3, color="#2196F3")

    # Add threshold lines
    ax.axhline(y=0.1, color="#FF9800", linestyle="--", label="Friction threshold")
    ax.axhline(y=0.3, color="#F44336", linestyle="--", label="Struggling threshold")

    ax.set_title("Daily Error Rate Trend")
    ax.set_xlabel("Date")
    ax.set_ylabel("Average Error Rate")
    ax.legend()
    ax.set_ylim(0, 1.0)

    plt.tight_layout()
    plt.savefig("data/error_trend.png", dpi=150)
    print("Saved error_trend.png")


def plot_health_pie():
    """Plot health label distribution as a pie chart."""
    dist = get_health_distribution()

    if sum(dist.values()) == 0:
        print("No metrics data available")
        return

    labels = list(dist.keys())
    sizes = list(dist.values())
    colors = ["#4CAF50", "#FF9800", "#F44336"]
    explode = (0.05, 0.05, 0.05)

    fig, ax = plt.subplots(figsize=(8, 8))
    ax.pie(
        sizes,
        explode=explode,
        labels=labels,
        colors=colors,
        autopct="%1.1f%%",
        shadow=True,
        startangle=140,
    )
    ax.set_title("AI Health Label Distribution")

    plt.tight_layout()
    plt.savefig("data/health_distribution.png", dpi=150)
    print("Saved health_distribution.png")


def plot_productivity_histogram():
    """Plot distribution of productivity scores."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    cursor = conn.execute("SELECT productivity_score FROM session_metrics")
    scores = [row["productivity_score"] for row in cursor.fetchall()]
    conn.close()

    if not scores:
        print("No productivity data")
        return

    fig, ax = plt.subplots(figsize=(10, 6))
    ax.hist(scores, bins=20, color="#9C27B0", edgecolor="white", alpha=0.8)
    ax.set_title("Productivity Score Distribution")
    ax.set_xlabel("Productivity Score (tools/turn)")
    ax.set_ylabel("Number of Sessions")
    ax.axvline(x=sum(scores) / len(scores), color="red", linestyle="--",
               label=f"Mean: {sum(scores)/len(scores):.2f}")
    ax.legend()

    plt.tight_layout()
    plt.savefig("data/productivity_hist.png", dpi=150)
    print("Saved productivity_hist.png")


if __name__ == "__main__":
    print("Generating analytics plots...")
    plot_error_trend()
    plot_health_pie()
    plot_productivity_histogram()
    print("Done!")

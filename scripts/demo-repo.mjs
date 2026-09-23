#!/usr/bin/env node
// Creates a small demo repository whose git history contains real-looking bug fixes, with some
// of those bugs still hiding elsewhere in the code. Try:
//   node scripts/demo-repo.mjs ../demo-shop && cd ../demo-shop && npx bugvax learn
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "demo-shop");
if (existsSync(join(dir, ".git"))) {
  console.error(`${dir} already contains a git repository`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
git("init", "-q", "-b", "main");
git("config", "user.name", "Demo Dev");
git("config", "user.email", "dev@example.com");
git("config", "core.autocrlf", "false");

let day = 0;
function commit(message, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content.replace(/^\n/, ""));
  }
  git("add", "-A");
  const date = new Date(Date.UTC(2026, 0, 5 + day++ * 3, 10)).toISOString();
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}

const refundsBuggy = `
import { db } from "./db";

export async function refundOrder(orderId: string, amount: number) {
  const order = await db.orders.find(orderId);
  if (!order) throw new Error(\`Order \${orderId} not found\`);
  order.refunded += amount;
  db.commit();
  return order;
}
`;

const authBuggy = `
import type { NextFunction, Request, Response } from "express";

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
  }
  next();
}
`;

const reportsBuggy = `
import { db } from "./db";

export async function topOrderTotals(limit = 10): Promise<number[]> {
  const orders = await db.orders.all();
  const totals = orders.map((o) => o.total);
  return totals.sort().reverse().slice(0, limit);
}
`;

const orderListBuggy = `
import { useEffect, useState } from "react";
import { api } from "../api";

export function OrderList() {
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    api.get("/orders").then(setOrders);
  });
  return <ul>{orders.map((o) => <li key={o.id}>{o.title}</li>)}</ul>;
}
`;

const cartBuggy = `
from app.models import Item


def add_item(cart, item: Item, tags=[]):
    tags.append(item.category)
    cart.items.append(item)
    cart.tags = tags
    return cart
`;

const shippingBuggy = `
import requests

RATES_URL = "https://rates.example.com/v1/quote"


def shipping_quote(weight_kg: float, country: str) -> float:
    resp = requests.get(RATES_URL, params={"weight": weight_kg, "country": country})
    resp.raise_for_status()
    return resp.json()["price"]
`;

commit("initial shop", {
  "README.md": "# demo-shop\n\nA tiny shop used to demo bugvax. Contians orders, invoices and payments.\n",
  "package.json": '{ "name": "demo-shop", "private": true }\n',
  "src/db.ts": `
export interface Order { id: string; total: number; refunded: number; title: string }
export interface Invoice { id: string; status: string; amount: number }

export const db = {
  orders: {
    async find(id: string): Promise<Order | undefined> { return undefined; },
    async all(): Promise<Order[]> { return []; },
  },
  invoices: {
    async find(id: string): Promise<Invoice> { return { id, status: "open", amount: 0 }; },
  },
  async commit(): Promise<void> {},
  async rollback(): Promise<void> {},
};
`,
  "src/api.ts": `export const api = { get: async (url: string) => fetch(url).then((r) => r.json()) };\n`,
  "src/refunds.ts": refundsBuggy,
  "src/invoices.ts": `
import { db } from "./db";

export async function voidInvoice(id: string) {
  const invoice = await db.invoices.find(id);
  invoice.status = "void";
  db.commit();
}

export async function markPaid(id: string) {
  const invoice = await db.invoices.find(id);
  invoice.status = "paid";
  await db.commit();
}
`,
  "src/middleware/auth.ts": authBuggy,
  "src/middleware/admin.ts": `
import type { NextFunction, Request, Response } from "express";

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: "forbidden" });
  }
  next();
}
`,
  "src/reports.ts": reportsBuggy,
  "src/leaderboard.ts": `
export function rankScores(scores: number[]): number[] {
  return scores.sort().reverse();
}

export function sortedPlayerNames(names: string[]): string[] {
  return names.sort();
}
`,
  "src/pricing.ts": `
export function orderTotal(subtotal: number, discount: number, taxRate: number): number {
  return subtotal * (1 + taxRate) - discount;
}
`,
  "src/components/OrderList.tsx": orderListBuggy,
  "src/components/InvoiceList.tsx": `
import { useEffect, useState } from "react";
import { api } from "../api";

export function InvoiceList() {
  const [invoices, setInvoices] = useState([]);
  useEffect(() => {
    api.get("/invoices").then(setInvoices);
  });
  return <ul>{invoices.map((i) => <li key={i.id}>{i.id}</li>)}</ul>;
}
`,
  "app/__init__.py": "",
  "app/models.py": `
class Item:
    def __init__(self, name: str, category: str):
        self.name = name
        self.category = category
`,
  "app/cart.py": cartBuggy,
  "app/wishlist.py": `
from app.models import Item


def add_to_wishlist(user, item: Item, notes={}):
    notes[item.name] = "added"
    user.wishlist.append(item)
    return notes
`,
  "app/shipping.py": shippingBuggy,
  "app/payments.py": `
import requests

PAYMENTS_URL = "https://pay.example.com/v1/charges"


def charge(amount_cents: int, token: str) -> str:
    resp = requests.post(PAYMENTS_URL, json={"amount": amount_cents, "token": token})
    resp.raise_for_status()
    return resp.json()["id"]
`,
});

commit("fix: await db commit when refunding orders\n\nRefunds were sometimes lost because commit() rejected after the response was sent.", {
  "src/refunds.ts": refundsBuggy.replace("  db.commit();", "  await db.commit();"),
});

commit("fix typo in README", {
  "README.md": "# demo-shop\n\nA tiny shop used to demo bugvax. Contains orders, invoices and payments.\n",
});

commit("fix: stop calling next() after sending 401\n\nUnauthenticated requests reached the handler anyway.", {
  "src/middleware/auth.ts": authBuggy.replace("    res.status(401).json({ error: \"unauthorized\" });", "    return res.status(401).json({ error: \"unauthorized\" });"),
});

commit("fix: default tags list was shared between carts", {
  "app/cart.py": cartBuggy
    .replace("tags=[]):", "tags=None):")
    .replace("    tags.append(item.category)", "    if tags is None:\n        tags = []\n    tags.append(item.category)"),
});

commit("fix: apply discount before tax", {
  "src/pricing.ts": `
export function orderTotal(subtotal: number, discount: number, taxRate: number): number {
  return (subtotal - discount) * (1 + taxRate);
}
`,
});

commit("fix: OrderList refetched orders on every render", {
  "src/components/OrderList.tsx": orderListBuggy.replace("  });\n  return", "  }, []);\n  return"),
});

commit("fix: shipping quote hung forever when rates API was down", {
  "app/shipping.py": shippingBuggy.replace(
    'params={"weight": weight_kg, "country": country})',
    'params={"weight": weight_kg, "country": country}, timeout=10)',
  ),
});

commit("fix: top order totals were sorted as strings", {
  "src/reports.ts": reportsBuggy.replace("totals.sort()", "totals.sort((a, b) => a - b)"),
});

console.log(`Demo repository created in ${dir}`);
console.log(git("log", "--oneline").trim());

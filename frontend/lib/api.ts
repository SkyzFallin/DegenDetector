const API = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

export async function getAlerts() {
  const r = await fetch(`${API}/alerts`, { cache: "no-store" });
  return r.json();
}
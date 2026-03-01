import { getAlerts } from "../lib/api";

export default async function Home() {
  const alerts = await getAlerts();

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Spike Monitor</h1>
      {alerts.map((a:any)=>(
        <div key={a.id}>{a.venue} - {a.severity}</div>
      ))}
    </main>
  );
}
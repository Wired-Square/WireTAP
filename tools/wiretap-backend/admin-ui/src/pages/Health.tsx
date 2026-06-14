import { useEffect, useState } from "react";
import { api } from "../api";

interface HealthInfo {
  status: string;
  version: string;
  db_ok: boolean;
}

export default function Health() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<HealthInfo>("/v1/health")
      .then(setHealth)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  return (
    <div className="card">
      <h2>Health</h2>
      {error && <p className="error">{error}</p>}
      {health && (
        <table>
          <tbody>
            <tr>
              <td className="muted">Status</td>
              <td>
                <span className={`badge ${health.status === "ok" ? "ok" : "revoked"}`}>
                  {health.status}
                </span>
              </td>
            </tr>
            <tr>
              <td className="muted">Backend version</td>
              <td className="mono">{health.version}</td>
            </tr>
            <tr>
              <td className="muted">Database reachable</td>
              <td>{health.db_ok ? "yes" : "no"}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

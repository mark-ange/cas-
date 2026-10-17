import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AxiosError } from "axios";
import api from "../lib/api";

export default function Login() {
  const [email, setEmail] = useState("admin@cas.local");
  const [password, setPassword] = useState("ChangeMeNow!123");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post("/auth/login", { email, password });
      navigate("/");
    } catch (err) {
      const message =
        err instanceof AxiosError
          ? err.response?.data?.message || "Login failed"
          : "Login failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white p-8 rounded-lg shadow-md w-96">
        <h1 className="text-2xl font-bold mb-6 text-center">CAS Login</h1>
        {error && <div className="bg-red-100 text-red-700 p-3 rounded mb-4">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border rounded px-3 py-2"
              required
            />
          </div>
          <div className="mb-6">
            <label className="block text-sm font-medium mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border rounded px-3 py-2"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <div className="mt-6 p-3 bg-gray-50 rounded text-xs">
          <div className="font-semibold mb-1">Test Accounts (pre-filled):</div>
          <div className="text-gray-600 break-all">admin@cas.local</div>
          <div className="text-gray-500">Password: ChangeMeNow!123</div>
          <hr className="my-2" />
          <div className="font-semibold mt-1">Other test accounts:</div>
          <div className="text-gray-600">resident1@cas.local</div>
          <div className="text-gray-500">Password: ResidentPass123!</div>
          <div className="text-gray-600 mt-1">water.dispatcher@cas.local</div>
          <div className="text-gray-500">Password: DispatcherPass!2024</div>
        </div>
      </div>
    </div>
  );
}

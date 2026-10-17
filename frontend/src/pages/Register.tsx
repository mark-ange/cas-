import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AxiosError } from "axios";

interface PurokOption {
  id: string;
  name: string;
}

interface BarangayOption {
  id: string;
  name: string;
  puroks?: PurokOption[];
}
import api from "../lib/api";

export default function Register() {
  const [formData, setFormData] = useState({
    fullName: "",
    email: "",
    password: "",
    phone: "",
    barangayId: "",
    purokId: "",
    waterOptIn: true,
    powerOptIn: true,
    privacyConsent: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const { data: barangays } = useQuery({
    queryKey: ["barangays"],
    queryFn: () => api.get("/localities/barangays").then((res) => res.data),
    retry: false,
  });

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, type } = e.target;
    const value = type === "checkbox"
      ? (e.target as HTMLInputElement).checked
      : e.target instanceof HTMLInputElement ? e.target.value : (e.target as HTMLSelectElement).value;
    setFormData({
      ...formData,
      [name]: value,
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post("/auth/register", formData);
      navigate("/login");
    } catch (err) {
      const message =
        err instanceof AxiosError
          ? err.response?.data?.message || "Registration failed"
          : "Registration failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const puroksForSelectedBg =
    barangays?.find((bg: BarangayOption) => bg.id === formData.barangayId)?.puroks || [];

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white p-8 rounded-lg shadow-md w-96">
        <h1 className="text-2xl font-bold mb-6 text-center">Register</h1>
        {error && <div className="bg-red-100 text-red-700 p-3 rounded mb-4">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Full Name</label>
            <input type="text" name="fullName" value={formData.fullName} onChange={handleChange} className="w-full border rounded px-3 py-2" required />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input type="email" name="email" value={formData.email} onChange={handleChange} className="w-full border rounded px-3 py-2" required />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Password (min 12 chars)</label>
            <input type="password" name="password" value={formData.password} onChange={handleChange} className="w-full border rounded px-3 py-2" required minLength={12} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Phone</label>
            <input type="tel" name="phone" value={formData.phone} onChange={handleChange} className="w-full border rounded px-3 py-2" placeholder="+639XXXXXXXXX" required />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Barangay</label>
            <select name="barangayId" value={formData.barangayId} onChange={handleChange} className="w-full border rounded px-3 py-2" required>
              <option value="">Select a barangay</option>
              {barangays?.map((bg: BarangayOption) => (
                <option key={bg.id} value={bg.id}>{bg.name}</option>
              ))}
            </select>
          </div>
          {formData.barangayId && (
            <div>
              <label className="block text-sm font-medium mb-1">Purok</label>
              <select name="purokId" value={formData.purokId} onChange={handleChange} className="w-full border rounded px-3 py-2">
                <option value="">Select a purok (optional)</option>
                {puroksForSelectedBg.map((p: PurokOption) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="waterOptIn" checked={formData.waterOptIn} onChange={handleChange} />
              <span className="text-sm">Water alerts</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="powerOptIn" checked={formData.powerOptIn} onChange={handleChange} />
              <span className="text-sm">Power alerts</span>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" name="privacyConsent" checked={formData.privacyConsent} onChange={handleChange} id="privacyConsent" required />
            <label htmlFor="privacyConsent" className="text-sm">I accept the privacy notice</label>
          </div>
          <button type="submit" disabled={loading || !formData.privacyConsent} className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700">
            {loading ? "Registering..." : "Register"}
          </button>
        </form>
      </div>
    </div>
  );
}

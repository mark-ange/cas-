import { useState } from "react";
import api from "../lib/api";

export default function Advisories() {
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    serviceType: "WATER",
    title: "",
    message: "",
    startAt: new Date().toISOString().slice(0, 16),
    endAt: "",
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/advisories", formData);
      setShowForm(false);
      // Refresh list
    } catch (error) {
      console.error("Failed to create advisory:", error);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">All Advisories</h2>
        <button onClick={() => setShowForm(true)} className="bg-blue-600 text-white px-4 py-2 rounded">
          New Advisory
        </button>
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
          <div className="bg-white p-6 rounded-lg w-96">
            <h3 className="text-xl font-bold mb-4">Create Advisory</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Service Type</label>
                <select name="serviceType" value={formData.serviceType} onChange={handleChange} className="w-full border rounded px-3 py-2">
                  <option value="WATER">Water</option>
                  <option value="POWER">Power</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Title</label>
                <input type="text" name="title" value={formData.title} onChange={handleChange} className="w-full border rounded px-3 py-2" required />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Message</label>
                <textarea name="message" value={formData.message} onChange={handleChange} className="w-full border rounded px-3 py-2" rows={4} required />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Start At</label>
                <input type="datetime-local" name="startAt" value={formData.startAt} onChange={handleChange} className="w-full border rounded px-3 py-2" required />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">End At (optional)</label>
                <input type="datetime-local" name="endAt" value={formData.endAt} onChange={handleChange} className="w-full border rounded px-3 py-2" />
              </div>
              <div className="flex gap-3">
                <button type="submit" className="flex-1 bg-blue-600 text-white py-2 rounded">Create</button>
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 bg-gray-300 py-2 rounded">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

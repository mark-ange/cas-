import { useState } from "react";
import { AxiosError } from "axios";
import api from "../lib/api";

export default function Profile() {
  const [formData, setFormData] = useState({
    fullName: "",
    email: "",
    phone: "",
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.put("/auth/me", {
        fullName: formData.fullName,
        phone: formData.phone,
      });
      alert("Profile updated!");
    } catch (err) {
      const message =
        err instanceof AxiosError
          ? err.response?.data?.message || "Update failed"
          : "Update failed";
      alert(message);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.newPassword !== formData.confirmPassword) {
      return alert("Passwords do not match");
    }
    try {
      await api.put("/auth/change-password", {
        currentPassword: formData.currentPassword,
        newPassword: formData.newPassword,
      });
      alert("Password changed!");
    } catch (err) {
      const message =
        err instanceof AxiosError
          ? err.response?.data?.message || "Failed to change password"
          : "Failed to change password";
      alert(message);
    }
  };

  return (
    <div className="space-y-8 max-w-4xl">
      <h2 className="text-2xl font-bold">Profile Settings</h2>

      <form onSubmit={handleUpdate} className="bg-white p-6 rounded-lg shadow space-y-4">
        <h3 className="text-lg font-semibold">Personal Information</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Full Name</label>
            <input type="text" name="fullName" value={formData.fullName} onChange={handleChange} className="w-full border rounded px-3 py-2" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input type="email" name="email" value={formData.email} onChange={handleChange} className="w-full border rounded px-3 py-2" disabled />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Phone</label>
            <input type="tel" name="phone" value={formData.phone} onChange={handleChange} className="w-full border rounded px-3 py-2" placeholder="+639XXXXXXXXX" />
          </div>
        </div>
        <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded">Save Changes</button>
      </form>

      <form onSubmit={handleChangePassword} className="bg-white p-6 rounded-lg shadow space-y-4">
        <h3 className="text-lg font-semibold">Change Password</h3>
        <div>
          <label className="block text-sm font-medium mb-1">Current Password</label>
          <input type="password" name="currentPassword" value={formData.currentPassword} onChange={handleChange} className="w-full border rounded px-3 py-2" required />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">New Password (min 12 chars)</label>
          <input type="password" name="newPassword" value={formData.newPassword} onChange={handleChange} className="w-full border rounded px-3 py-2" required minLength={12} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Confirm New Password</label>
          <input type="password" name="confirmPassword" value={formData.confirmPassword} onChange={handleChange} className="w-full border rounded px-3 py-2" required />
        </div>
        <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded">Change Password</button>
      </form>
    </div>
  );
}

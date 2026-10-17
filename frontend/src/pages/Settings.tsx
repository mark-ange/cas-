import { useState } from "react";

export default function Settings() {
  const [settings, setSettings] = useState({
    notifications: true,
    emailAlerts: true,
    smsAlerts: false,
    darkMode: false,
  });

  const toggleSetting = (key: string) => {
    setSettings((prev) => ({ ...prev, [key]: !prev[key as keyof typeof prev] }));
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <h2 className="text-2xl font-bold">Settings</h2>
      
      <div className="bg-white p-6 rounded-lg shadow space-y-4">
        <h3 className="text-lg font-semibold">Notification Preferences</h3>
        
        <div className="space-y-3">
          <label className="flex items-center justify-between">
            <span>Enable Notifications</span>
            <button
              type="button"
              role="switch"
              onClick={() => toggleSetting("notifications")}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.notifications ? 'bg-blue-600' : 'bg-gray-300'}`}
            >
              <span className={`absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform ${settings.notifications ? 'translate-x-5' : ''}`} />
            </button>
          </label>
          
          <label className="flex items-center justify-between">
            <span>Email Alerts</span>
            <button
              type="button"
              onClick={() => toggleSetting("emailAlerts")}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.emailAlerts ? 'bg-blue-600' : 'bg-gray-300'}`}
            >
              <span className={`absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform ${settings.emailAlerts ? 'translate-x-5' : ''}`} />
            </button>
          </label>
          
          <label className="flex items-center justify-between">
            <span>SMS Alerts</span>
            <button
              type="button"
              onClick={() => toggleSetting("smsAlerts")}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.smsAlerts ? 'bg-blue-600' : 'bg-gray-300'}`}
            >
              <span className={`absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform ${settings.smsAlerts ? 'translate-x-5' : ''}`} />
            </button>
          </label>
          
          <label className="flex items-center justify-between">
            <span>Dark Mode</span>
            <button
              type="button"
              onClick={() => toggleSetting("darkMode")}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.darkMode ? 'bg-blue-600' : 'bg-gray-300'}`}
            >
              <span className={`absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform ${settings.darkMode ? 'translate-x-5' : ''}`} />
            </button>
          </label>
        </div>
      </div>
    </div>
  );
}

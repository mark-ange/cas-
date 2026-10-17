import { NavLink } from "react-router-dom";

export default function Sidebar() {
  const navItems = [
    { name: "Dashboard", path: "/" },
    { name: "Advisories", path: "/advisories" },
    { name: "Profile", path: "/profile" },
    { name: "Settings", path: "/settings" },
  ];

  return (
    <nav className="w-64 bg-white shadow-md">
      <div className="p-4 border-b">
        <h1 className="text-xl font-bold text-blue-600">CAS</h1>
        <p className="text-sm text-gray-500">Community Alert System</p>
      </div>
      <ul className="py-4">
        {navItems.map((item) => (
          <li key={item.name}>
            <NavLink
              to={item.path}
              className={({ isActive }) =>
                `flex items-center px-4 py-2 text-gray-700 hover:bg-blue-50 transition-colors ${
                  isActive ? "bg-blue-100 border-l-4 border-blue-600" : ""
                }`
              }
            >
              {item.name}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

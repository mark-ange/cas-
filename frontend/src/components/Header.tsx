import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../lib/api";

export default function Header() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const logout = useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth-user"] });
      navigate("/login");
    },
  });

  return (
    <header className="bg-white shadow-sm border-b px-6 py-4 flex justify-end">
      <button
        onClick={() => logout.mutate()}
        className="text-gray-700 hover:text-gray-900"
      >
        Logout
      </button>
    </header>
  );
}

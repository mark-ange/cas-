import { useQuery } from "@tanstack/react-query";
import api from "../lib/api";

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: string;
  active: boolean;
}

export function useAuth() {
  const {
    data: user,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["auth-user"],
    queryFn: () => api.get("/auth/me").then((res) => res.data),
    retry: false,
  });

  return {
    user,
    isAuthenticated: !!user,
    isLoading,
    error,
  };
}

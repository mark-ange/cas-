import { useQuery } from "@tanstack/react-query";
import api from "../lib/api";

export interface Advisory {
  id: string;
  serviceType: "WATER" | "POWER";
  title: string;
  message: string;
  startAt: string;
  endAt?: string;
  status: "SCHEDULED" | "ACTIVE" | "RESOLVED" | "CANCELLED";
  createdAt: string;
  createdBy: {
    fullName: string;
  };
}

export default function Dashboard() {
  const { data: advisories, isLoading } = useQuery({
    queryKey: ["advisories"],
    queryFn: () => api.get("/advisories").then((res) => res.data),
  });

  if (isLoading) return <div className="text-center py-10">Loading advisories...</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Community Advisories</h2>
      <div className="space-y-4">
        {advisories?.map((advisory: Advisory) => (
          <div key={advisory.id} className="bg-white p-6 rounded-lg shadow">
            <h3 className="text-xl font-semibold">{advisory.title}</h3>
            <p className="text-gray-600 mt-2">{advisory.message}</p>
            <div className="mt-4 text-sm text-gray-500">
              Service: {advisory.serviceType} | Status: {advisory.status}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

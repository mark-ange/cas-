import axios from "axios";

const API_BASE_URL =
  typeof import.meta !== "undefined" && import.meta.env
    ? import.meta.env.VITE_API_URL || "http://localhost:4000/api"
    : "http://localhost:4000/api";

const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      window.location.href = "/login";
    }
    return Promise.reject(error);
  }
);

export default api;

const API = import.meta.env.VITE_API_URL || "http://localhost:4001/api";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function parseBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export async function api<T = any>(
  path: string,
  options: RequestInit & { token?: string | null } = {}
): Promise<T> {
  const { token, headers, ...rest } = options;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    }
  });
  const data = await parseBody(res);
  if (!res.ok) {
    const message =
      data?.message ||
      (Array.isArray(data?.issues) ? data.issues.map((i: any) => i.message).join(", ") : null) ||
      `Erreur HTTP ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export { API };

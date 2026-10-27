export async function uploadToSignedUrl(url: string, file: File) {
  const body = new FormData();
  body.append("cacheControl", "3600");
  body.append("", file);
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const response = await fetch(url, { method: "PUT", body, headers: { "x-upsert": "false", ...(key ? { apikey: key } : {}) } });
  if (!response.ok) throw new Error("The upload didn't finish.");
}

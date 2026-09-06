export function isSafeBranchName(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.includes("@{")) {
    return false;
  }
  if (value.endsWith(".") || value.endsWith("/") || value.endsWith(".lock")) {
    return false;
  }
  return value
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith("."));
}

export async function releaseOAuth(local: () => void, deploy: () => void, remote: () => Promise<void>) {
  local(); deploy(); await remote();
}

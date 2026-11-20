/**
 * Fallback copies of two public documents ChatGPT publishes for its connectors, as fetched on
 * 2026-11-20: its Client ID Metadata Document and the JWKS its client assertions are signed with.
 *
 * chatgpt.com's bot protection can refuse a Worker's fetch of these documents (it answers 403 to
 * workerd's requests while answering 200 to curl). The demo always fetches them live first; only
 * when that fetch fails does it use these copies. If ChatGPT rotates its key, the live JWKS is
 * needed again: a stale copy can only make sign-in fail, never let another key in.
 */
export const PINNED_DOCS: Record<string, unknown> = {
  'https://chatgpt.com/oauth/client.json': {"client_id":"https://chatgpt.com/oauth/client.json","client_uri":"https://chatgpt.com/","redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],"token_endpoint_auth_method":"private_key_jwt","token_endpoint_auth_methods_supported":["none","private_key_jwt"],"grant_types":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"response_types":["code"],"client_name":"ChatGPT","logo_uri":"https://persistent.oaistatic.com/sonic/misc/openai-logo.png","token_endpoint_auth_signing_alg":"RS256","jwks_uri":"https://chatgpt.com/oauth/jwks.json"},
  'https://chatgpt.com/oauth/jwks.json': {"keys":[{"kty":"RSA","kid":"cimd-20260428030119","use":"sig","alg":"RS256","n":"y09nMyYX6LhSgS3YmbLOZrFoR8SffxG0kM5gQ5PKpHVMzbAu__-7rf0_Q_pwhVa9vxJzv3cRkGnXKNWKOHDdEXp8YFPVUql4NcDjDdS_0w0uos8gazoa7Td47qVquxOsG3861l8oKEh-E4r5C_6w6Sx0Rl2WEEs2-dmvn3fwH9PkLCQOo4tsNAEnrW_ge2vQE-pFo-kJp5QRRiX2w0YvaMFtIfEvNbdPSJ3xd7NbGrvRt279HrxgDLGUvpbeWrCsp3D7HdR2QZn-9MZp7CHPlMGtFgN9aIB4Guf7qYlRiC3Ja0ZI22jSMct6xrI-90XX4AK2FhiWmYOmjV_2d3vEVw","e":"AQAB"}]},
};

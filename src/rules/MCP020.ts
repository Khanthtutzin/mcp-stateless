import type { ProbeContext } from '../probe/context.js';
import { specUrl } from '../protocol.js';
import { authorizationServers } from './oauth.js';
import { finding, type Finding, type Rule } from './types.js';

/**
 * 2026-07-28 deprecated OAuth 2.0 Dynamic Client Registration (RFC 7591) in
 * favour of Client ID Metadata Documents: the client's `client_id` is an
 * HTTPS URL to a document describing it, so a client and a server with no
 * prior relationship need no registration round trip at all. DCR still works
 * through the deprecation window, but an authorization server offering it
 * with no CIMD path leaves every new client on the mechanism being removed.
 *
 * Only that combination is reported. An authorization server with neither
 * relies on pre-registration, which is still a supported mechanism, and one
 * that offers both is already migrated. Metadata inspection only, as MCP019.
 */
export const MCP020: Rule = {
  id: 'MCP020',
  title: 'Authorization server offers only deprecated Dynamic Client Registration',
  remediation: 'application',
  severity: 'warning',
  specRef: specUrl('basic/authorization/client-registration'),
  changelogRef: 'Deprecated 4',
  appliesTo: ['http'],

  async run(ctx: ProbeContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const as of await authorizationServers(ctx)) {
      const registration = as.doc['registration_endpoint'];
      if (typeof registration !== 'string' || registration.length === 0) continue;
      if (as.doc['client_id_metadata_document_supported'] === true) continue;

      findings.push(
        finding(this, {
          observed: `The metadata for authorization server ${as.issuer} (${as.url}) advertises a registration_endpoint for Dynamic Client Registration, and does not set client_id_metadata_document_supported to true.`,
          expected:
            'Authorization servers SHOULD support Client ID Metadata Documents and advertise it with client_id_metadata_document_supported: true. Dynamic Client Registration is deprecated and retained only for backward compatibility.',
          fix: `Enable Client ID Metadata Document support on ${as.issuer} — accept HTTPS URLs as client_id and fetch the document they name — and publish client_id_metadata_document_supported: true. Keep the registration_endpoint for older clients until the deprecation window closes.`,
          evidence: [],
        }),
      );
    }
    return findings;
  },
};

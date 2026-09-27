import type { ProbeContext } from '../probe/context.js';
import { specUrl } from '../protocol.js';
import { authorizationServers } from './oauth.js';
import { finding, type Finding, type Rule } from './types.js';

/**
 * SEP-2468 brought RFC 9207 into MCP: an authorization server SHOULD return
 * `iss` in its authorization responses, and advertise that it does with
 * `authorization_response_iss_parameter_supported`. Without it a client
 * talking to more than one authorization server cannot tell which one a
 * response came from — the opening a mix-up attack needs — and the spec's own
 * validation table leaves such a client nothing to check.
 *
 * This inspects published metadata only. It never starts an authorization
 * flow, and never sends the user's headers to the hosts the metadata names.
 */
export const MCP019: Rule = {
  id: 'MCP019',
  title: 'Authorization server does not advertise RFC 9207 iss support',
  remediation: 'application',
  severity: 'warning',
  specRef: specUrl('basic/authorization'),
  changelogRef: 'Minor change 7 (SEP-2468)',
  appliesTo: ['http'],

  async run(ctx: ProbeContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const as of await authorizationServers(ctx)) {
      const flag = as.doc['authorization_response_iss_parameter_supported'];
      if (flag === true) continue;

      findings.push(
        finding(this, {
          observed:
            flag === undefined
              ? `The metadata for authorization server ${as.issuer} (${as.url}) has no authorization_response_iss_parameter_supported field.`
              : `The metadata for authorization server ${as.issuer} (${as.url}) sets authorization_response_iss_parameter_supported to ${JSON.stringify(flag)}.`,
          expected:
            'MCP authorization servers SHOULD include iss in authorization responses (RFC 9207), and advertise it by setting authorization_response_iss_parameter_supported to true.',
          fix: `Enable the iss authorization response parameter on ${as.issuer} and publish authorization_response_iss_parameter_supported: true in its metadata. With a hosted identity provider this is usually a setting, not code.`,
          evidence: [],
        }),
      );
    }
    return findings;
  },
};

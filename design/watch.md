Decision: The board looks at GitHub itself, with one query for each configured repository at most every five minutes and as the owner, and when GitHub reports every pull request counted for a merge row merged, the board marks that row done and logs it in one commit through an operation that has no MCP tool and that no role may call, because every session on the account shares GitHub's request quota and the PM would otherwise check each merge by hand every round ([Watching GitHub](../docs/design.md#watching-github), [Credentials](../docs/design.md#credentials)), instead of each session or the PM polling GitHub on its own.

Rejected:
- Each session or the PM polling GitHub by hand: rejected because every session on the account shares GitHub's request quota and the PM would repeat the check every round.
- GitHub webhooks to a relay: rejected because the daemon binds the loopback address only, so a webhook would need a relay that the board does not have.

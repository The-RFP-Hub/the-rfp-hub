# My Answers: ENS (DAO Funder - ENS PG + MetaGov)

_Part of: Sov's Answers for RFP_

Seat: elected ENS DAO Meta-Governance Working Group Steward for Term 7 (Jul 2026 to Jun 2027), serving alongside netto.eth and abdullahumar.eth. Before MetaGov, I served on the ENS Public Goods Working Group for more than a year. I have also been on the applicant side, proposing a distribution and channel program to the DAO. These answers cover the DAO funder side; the ENS Labs protocol team interview is a separate data point.
Sov's answers to the M1 publisher questions, from the ENS DAO seat.

## Core frame
From 2024 through mid-2026, "ENS grants" was never one clean program. It was a set of funding lanes with different owners, sizes, and decision paths:
Ecosystem Working Group funded ENS-specific or ENS-centric builders, usually retroactively, with a technical bias. Think ENS Ideas, ENS Data, Fluidkey, WebHash, Blockscout, 3DNS, Web3.bio, Enscribe, Yodl, and similar projects. The best sources are the Term 5 and Term 6 grant summary threads.
Public Goods Working Group funded broader Ethereum and web3 public goods, not primarily ENS-specific work. In 2025 it had two lanes: smaller Builder Grants and larger Strategic Grants. Strategic Grants went to DRC, Remix, Fabric, Vyper, Argot, and ICANN policy work. Builder Grants ran through builder.ensgrants.xyz and are now closed because the PGWG is sunsetting.
Service Provider Program funded ongoing service relationships, not small one-off grants. SPP2 ran in 2025 at $4.5M/year across eight providers: ETH.LIMO, NameHash Labs, Blockful, Unruggable, Ethereum Identity Foundation, Namespace, JustaName, and ZK Email. SPP3 is running now in 2026 through a committee model, with roughly $3.25M available for providers after committee costs.

## Core questions
1. How does ENS publish / find / index funding opportunities?
Mostly through forum threads, working group posts, Snapshot / on-chain proposals, and program-specific pages.
Ecosystem grants live in term summary threads and weekly call context. Public Goods grants lived in the builder grants platform and individual forum posts. SPP lives in governance proposals, application threads, voting tools, implementation posts, and provider reports.  For SPP3 we used a Claude/Notion system that worked fairly well for intake and evaluation.
Discovery is public, but it is forum-native. The information exists, but it is not shaped like a clean opportunity listing. Applicants need to know which thread matters, which term is active, who owns the lane, and whether the window is actually open.
2. Where does that process break down?
The biggest failure is routing. A builder can see "ENS funding" and still not know whether they belong in Ecosystem, Public Goods, SPP, or a bespoke governance proposal.  As an example we saw many applications for ENS Ecosystem come into Public Goods because Builder Grants was easier to find versus the Ecosystem WG Grant Submission Form.
The second failure is status drift. Public Goods Builder Grants look like a live program if you find an old post, but the platform now says applications are closed because the working group is sunsetting. SPP3 was open in May and June 2026, but by July it moved into recommendation / ratification. Generic grant directories tend to miss that state change.
The third failure is scale mismatch. SPP3 had a $200K minimum and was designed for ongoing service relationships. The committee explicitly noted that several rejected applications were "right work, wrong program": good discrete ENS work that did not fit a 12-month service-provider scope. That is a clean signal that ENS has demand for a mid-sized grants lane that is not currently obvious.
3. What information is most often missing or wrong in listings?
Listings usually flatten the structure. They say "ENS grants" and lose the useful information.
The missing fields are: funding lane, owner, status, term or season, open and close dates, funding range, decision path, fit criteria, required evidence, and canonical source. For ENS, those are not details. They are the listing.
The most important fit distinction is:
- ENS-specific technical work → Ecosystem (no closed down - may reopen with MetaGov in Term 7)
- Broad Ethereum / web3 public good → Public Goods (now closed down)
- Ongoing ENS service relationship above $200K → SPP
- Discrete sub-$200K ENS project → likely needs a different or future lane
4. What would a neutral, open hub need to do for ENS to use it weekly?
It needs to be a routing layer, not just a directory.
A useful ENS page in the RFP Hub would show the active and historical lanes separately: Ecosystem grants, Public Goods Builder Grants, Public Goods Strategic Grants, SPP2, and SPP3. Each listing should show status, owner, dates, funding range, fit criteria, decision path, and canonical forum/proposal links.
The maintenance model should be steward- or committee-permissioned. Anything that requires DAO-wide approval for every listing will not work. The practical model is: the relevant steward, committee chair, or MetaGov owner can update their lane, with canonical links attached.
5. Which fields matter?
For ENS, the minimum viable RFP Hub object needs:
Program lane, owning body, status, term / season, open date, close date, decision date, funding type, funding range, eligibility, decision path, evidence required, reporting obligation, payout method, canonical source, and current contact.
If the hub captures only title, description, amount, and deadline, it will recreate the same confusion that already exists.
6. Would you contribute data back?
Most ENS funding data is already public: Ecosystem grant summary threads, Public Goods term reports, the builder grants platform, ENS Working Group Spending Summaries, SPP2 application / voting / implementation docs, and SPP3 artifacts.
The work is not disclosure. It is formatting, ownership, and status maintenance. I can champion that inside MetaGov, but I cannot commit the DAO by myself.

## Publisher tail
What would make ENS publish directly to the hub?
Ecosystem stewards should be able to update Ecosystem grant listings. The Public Goods steward or successor owner should be able to mark PG history and sunset status. The SPP committee or MetaGov owner should be able to update SPP3. Historical records can be imported from the forum and spending summaries.
The hub should make that easy without creating a parallel governance process.
What would a verified publisher need to include?
A verified ENS publisher record should include the governance mandate link, program owner, current contact, term or season, status timestamp, budget envelope, funding instrument, eligibility, application route, decision path, reporting requirements, and canonical source.  We would also want the system to have ENS Functionality.

## RFP Hub takeaway
The product should answer:
- Which ENS funding lane is this?
- Is it open right now?
- Who owns it?
- What size and type of work fits?
- What is the decision path?
- Where is the canonical source?
That is the value of the RFP Hub for a DAO like ENS: not more visibility, better routing.
# Openings for job seekers

Openings helps an AI agent find real jobs from public company career systems and explain why each job does or does not fit your resume. Its useful difference is **hidden-job discovery**: it can surface relevant roles whose titles you might not have searched for yourself.

It is application-safe. It cannot apply for a job, fill a form, or submit your resume. It has no account system and does not store your resume or extracted profile. It writes only its private local job index.

## Before sharing your resume

Ask the agent to prepare and check coverage for your target country:

> Prepare Openings for India. Before I share my resume, tell me how many current jobs, employers, and indexed sources it covers.

Coverage is job-level, not a marketing estimate. A company counts only when the local snapshot contains a job classified as eligible for the requested country. If coverage is thin, the agent should say so before asking for personal information.

## Find jobs

Openings currently accepts resume content as text or Markdown. If your resume is a PDF or DOCX, ask your MCP host to extract it to text first.

> Use this resume to find backend or platform roles in India. I prefer remote or Bengaluru, and I do not want people-management roles. Rank by evidence. Include hidden opportunities and explain supported requirements, gaps, assumptions, and whether the job data was refreshed.

You can choose either ranking mode:

- **Evidence score** asks how much of the job's detected requirements the resume supports with exact, traceable facts. Use this by default when trust and fit matter most.
- **Keyword score** asks how much relevant language overlaps. It can help discover adjacent roles, but overlap is not proof of competence.

Both scores are returned. Changing the ranking mode changes ordering, not the underlying resume evidence.

## Understand one result

> Analyze this job against my resume. Separate direct support, transferable evidence, unsupported requirements, screening risks, and interview preparation gaps. Do not infer work authorization or experience from silence.

For a hidden result, the response should name the title expansion that found it and whether that expansion came from your explicit intent or validated resume facts.

## Improve the resume truthfully

> Suggest a job-specific resume revision. Use only claims already supported by my resume, cite the supporting facts, and leave unsupported job requirements as gaps.

Openings can return reviewable suggestions, an additive unified diff, or revised Markdown. It never overwrites the original and never inserts a skill merely because the job asks for it.

## Example conversation

**Candidate:** What does Openings cover in India?

**Agent:** Calls `prepare_job_search` and follows `nextAction`: it passes the returned opaque `continuation` into the next call while the result says `call_again`, stops and explains failures on `retry_later`, and presents the returned source, employer, and job counts without recalculating them when ready.

**Candidate:** That is useful. Here is my Markdown resume. Find backend roles, but exclude engineering-manager jobs.

**Agent:** Calls `recommend_jobs` with the explicit constraints and evidence ranking. It presents direct, hidden, and stretch results separately, including both percentages and material gaps.

**Candidate:** Why is the hidden platform role a fit?

**Agent:** Calls `analyze_job_fit` for that stable job ID and presents only the returned evidence and risks.

**Candidate:** Help me tailor my resume for it.

**Agent:** Calls `optimize_resume`, shows the evidence-linked changes, and asks the candidate to verify them.

## Common limitations and recovery

- **`unsupported_resume_format`**: native PDF/DOCX parsing is not implemented. Extract the document to text or Markdown in the host and retry.
- **Thin coverage**: coverage differs substantially by country. Treat a small result as a corpus limitation, not proof that no matching job exists.
- **Thin resume**: add explicit, truthful projects, internships, technologies, outcomes, and target roles. Openings deliberately avoids inventing signals that are absent.
- **Work authorization**: state hard country and sponsorship needs explicitly. Openings does not infer authorization from a location or resume silence.
- **Evidence disagreement**: inspect the cited resume span and job text. Keyword overlap is never presented as demonstrated experience.

## Connect the MCP server

Install Bun 1.3 or newer, then install Openings:

```sh
bun add --global openings
```

In a client that accepts MCP configuration, add this stdio server:

```json
{
  "mcpServers": {
    "openings": {
      "command": "openings-mcp",
      "args": []
    }
  }
}
```

The first `prepare_job_search` call starts a private index under `~/.openings` from verified structured job sources. Each call handles at most ten missing or stale sources, gives each source one bounded 90-second attempt, and returns `nextAction`, allowing the agent to continue across MCP requests. It crawls every currently missing verified source because a source's country eligibility is known only after its jobs are indexed; the requested countries control the coverage returned to the candidate, not which employers are assumed to belong to a country. Successful batches are cached, failures are reported, and later calls rotate past failed sources so the rest of the catalog can progress. Partitions older than 14 days are refreshed. Once all sources are fresh, the setup call makes no network request.

For development from a source checkout, point the server at the absolute `src/mcp.ts` path and set `OPENINGS_DATA_DIR` to the repository's absolute `.openings` directory:

```json
{
  "mcpServers": {
    "openings": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/hiring-agent/src/mcp.ts"],
      "env": {
        "OPENINGS_DATA_DIR": "/absolute/path/to/hiring-agent/.openings"
      }
    }
  }
}
```

The packaged commands use `~/.openings` by default. The source entrypoint uses `.openings` under the MCP process's working directory unless `OPENINGS_DATA_DIR` is set. The included `.mcp.json` provides the repository-local configuration when this repository is installed as a Codex plugin.

The MCP interface exposes setup, coverage, recommendation, fit analysis, resume optimization, search, and job-detail tools. There is no application-submission tool.

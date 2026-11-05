A user of this app filed a fix request from inside the running app. Their words:

<request>
{{prompt}}
</request>

{{screenshot_note}}

Report metadata:

{{metadata}}

How to work:

- You are in a git worktree on branch `{{branch}}`, made from `{{base_branch}}`. Work only here.
- Find the code behind what the user describes, make the change, and keep it focused on the request.
- Build and run the relevant tests if the project has them.
- Commit with a clear message, push the branch (`git push -u origin {{branch}}`), and open a pull request against `{{base_branch}}` with `gh pr create --base {{base_branch}} --head {{branch}}`.
- In the PR body, quote the user's request, describe what you changed and why, and mention that it came from fixr report `{{job_id}}`.
- Don't ask questions: nobody is watching this session. Where the request is ambiguous, make a reasonable assumption and list your assumptions in the PR body.
- If the request can't be done safely (it needs secrets, data migrations or a product decision), open a draft PR or none, and explain why in your final message.

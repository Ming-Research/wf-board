# The design tree (design/) is checked by the Design-skill submodule at design/skill; `git submodule update --init
# design/skill` fetches it. The shared rules name these two targets. The repository's other commands are npm scripts.
# design-lint runs on every push, design-ready on a pull request that is ready for review and on the main line (the
# workflow design.yml, which also picks the base with design/skill/review-base.sh).
PY ?= python3
DESIGN_TREES := daemon deploy storage plans items cards responsibility mcp wake watch page testing
DESIGN_REVIEW_BASE ?= origin/main

design-lint:
	@$(PY) -B -m unittest discover -s design/skill -p 'test_lint.py'
	@$(PY) -B design/skill/lint.py --root design --trees $(DESIGN_TREES) --base "$(DESIGN_REVIEW_BASE)"

design-ready:
	@$(PY) -B design/skill/lint.py --root design --trees $(DESIGN_TREES) --base "$(DESIGN_REVIEW_BASE)" --require-approval

.PHONY: design-lint design-ready

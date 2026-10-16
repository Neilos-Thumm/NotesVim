.PHONY: app install test run clean

app:
	./scripts/build-app.sh

install:
	./scripts/build-app.sh --install

# Vim behaviour tests (real engine + adapter + fake Notes); needs Node.
test:
	node tests/vim.test.js

# Run from the terminal for development. Accessibility permission then goes to
# your terminal app instead of NotesVim.
run:
	swift run

clean:
	rm -rf .build build

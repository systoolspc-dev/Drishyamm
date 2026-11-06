.PHONY: install dev test run lint clean

install:            ## editable install with runtime deps
	pip install -e .

dev:                ## editable install with dev + preview extras
	pip install -e ".[dev,preview]"

test:               ## run the test suite
	pytest -q

run:                ## start the server (config/config.yaml)
	python -m headcount --config config/config.yaml

preview:            ## local GUI preview window (needs the preview extra)
	python scripts/preview.py

clean:
	rm -rf build dist src/*.egg-info .pytest_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

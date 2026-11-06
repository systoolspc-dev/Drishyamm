.PHONY: install dev test run probe clean

install:            ## editable install with runtime deps
	pip install -e .

dev:                ## editable install with dev extras
	pip install -e ".[dev]"

test:               ## run the test suite
	pytest -q

run:                ## start the server (config/config.yaml)
	python -m activity_monitor --config config/config.yaml

probe:              ## tune activity thresholds on an image: make probe IMG=path.jpg
	python scripts/probe_activity.py $(IMG)

clean:
	rm -rf build dist src/*.egg-info .pytest_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

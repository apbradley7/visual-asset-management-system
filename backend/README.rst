This package uses ![poetry](https://python-poetry.org/) for dependency management.

Make sure you have poetry installed and your local python version is using the python 3.10.

VAMS uses multiple lambda layers to store the dependencies when used on AWS. Each layer has its own poetry file and dependencies lists. 
The top level poetry/requirements are used for local testing only and are a combined list of requirements from all layers. 

Use the below for each layer or top-level tree. 

-------------

### How to build these packages
The Dockerfile should do everything you would need. If you included new dependencies make sure you export them into the requirements file.

More Details:
https://github.com/aws/aws-cdk/issues/14201

### Adding New Dependencies or updating package versions
`poetry add stepfunctions`

### Removing Dependencies
`poetry remove stepfunctions`

### Export poetry dependecies to requirements.txt
`poetry export -o requirements.txt --without-hashes`

### Move requirements.txt to ./lambdaLayers/<LAYERNAME>
`cp -rf ./requirements.txt ./lambdaLayers/<LAYERNAME>/requirements.txt`


### Running Tests - top level backend
`make all` should trigger all the code checks we have included so far
We use
1. flake8 for linting
2. mypy for type checks
3. pytest for running Tests
4. coverage to run code coverage

### Why does my PR fail in actions

Likely because of some failure while `make all`.

Try running github actions locally with [act](https://github.com/nektos/act/)

`act` should pickup the current ci.yml and run it locally inside a docker container
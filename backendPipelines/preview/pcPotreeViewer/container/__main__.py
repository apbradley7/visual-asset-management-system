# Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import logging
import sys
from .pipelines import core
from .utils.pipeline.objects import PipelineStatus
from .utils.logging import log

log.set_log_level(logging.INFO)


def main():
    core.hello()

    # run core application
    if sys.argv[1] == "localTest":
        #Local Test input
        testStageNameInput = sys.argv[2]
        testInput = "{\"jobName\": \"XXX\", \"stages\": [{\"type\": \""+testStageNameInput+"\", \"inputFile\": {\"bucketName\": \"XXX\", \"objectKey\": \"XXX\", \"fileExtension\": \"XXX\"}, \
            \"outputFiles\": {\"bucketName\": \"XXX\", \"objectDir\": \"XXX\"}, \"outputMetadata\": {\"bucketName\": \"XXX\", \"objectDir\": \"XXX\"}, \
            \"temporaryFiles\": {\"bucketName\": \"XXX\", \"objectDir\": \"XXX\"}}], \"inputMetadata\":\"\", \"inputParameters\":\"\", \
            \"externalSfnTaskToken\":\"\", \"localTest\":\"True\"}"
        
        response = core.run(json.loads(testInput))
    else:
        response = core.run(json.loads(sys.argv[1]))

    # exit application with status
    exit_status = 0 if response.status is PipelineStatus.COMPLETE else 1
    exit(exit_status)


if __name__ == "__main__":
    main()

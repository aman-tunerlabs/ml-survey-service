/**
 * name : observationSubmissions/helper.js
 * author : Akash
 * created-date : 20-Jan-2019
 * Description : Observations Submissions helper functionality.
 */

// Dependencies

let slackClient = require(ROOT_PATH + "/generics/helpers/slackCommunications");
let kafkaClient = require(ROOT_PATH + "/generics/helpers/kafkaCommunications");
const emailClient = require(ROOT_PATH + "/generics/helpers/emailCommunications");
const submissionsHelper = require(MODULES_BASE_PATH + "/submissions/helper")
const criteriaHelper = require(MODULES_BASE_PATH + "/criteria/helper")
const questionsHelper = require(MODULES_BASE_PATH + "/questions/helper")

/**
    * ObservationSubmissionsHelper
    * @class
*/
module.exports = class ObservationSubmissionsHelper {

      /**
   * Push completed observation submission in kafka for reporting.
   * @method
   * @name pushCompletedObservationSubmissionForReporting
   * @param {String} observationSubmissionId -observation submission id.
   * @returns {JSON} - message that observation submission is pushed to kafka.
   */

    static pushCompletedObservationSubmissionForReporting(observationSubmissionId) {
        return new Promise(async (resolve, reject) => {
            try {

                if (observationSubmissionId == "") {
                    throw "No observation submission id found";
                }

                if(typeof observationSubmissionId == "string") {
                    observationSubmissionId = ObjectId(observationSubmissionId);
                }

                let observationSubmissionsDocument = await database.models.observationSubmissions.findOne({
                    _id: observationSubmissionId,
                    status: "completed"
                }).lean();

                if (!observationSubmissionsDocument) {
                    throw messageConstants.apiResponses.SUBMISSION_NOT_FOUND+"or"+messageConstants.apiResponses.SUBMISSION_STATUS_NOT_COMPLETE;
                }

                const kafkaMessage = await kafkaClient.pushCompletedObservationSubmissionToKafka(observationSubmissionsDocument);

                if(kafkaMessage.status != "success") {
                    let errorObject = {
                        formData: {
                            observationSubmissionId:observationSubmissionsDocument._id.toString(),
                            message:kafkaMessage.message
                        }
                    };
                    slackClient.kafkaErrorAlert(errorObject);
                }

                return resolve(kafkaMessage);

            } catch (error) {
                return reject(error);
            }
        })
    }

     /**
   * Push observation submission to queue for rating.
   * @method
   * @name pushObservationSubmissionToQueueForRating
   * @param {String} [observationSubmissionId = ""] -observation submission id.
   * @returns {JSON} - message
   */

    static pushObservationSubmissionToQueueForRating(observationSubmissionId = "") {
        return new Promise(async (resolve, reject) => {
            try {

                if (observationSubmissionId == "") {
                    throw messageConstants.apiResponses.OBSERVATION_SUBMISSION_ID_NOT_FOUND;
                }


                if(typeof observationSubmissionId !== "string") {
                    observationSubmissionId = observationSubmissionId.toString();
                }

                const kafkaMessage = await kafkaClient.pushObservationSubmissionToKafkaQueueForRating({submissionModel : "observationSubmissions",submissionId : observationSubmissionId});

                if(kafkaMessage.status != "success") {
                    let errorObject = {
                        formData: {
                            submissionId:observationSubmissionId,
                            submissionModel:"observationSubmissions",
                            message:kafkaMessage.message
                        }
                    };
                    slackClient.kafkaErrorAlert(errorObject);
                }

                return resolve(kafkaMessage);

            } catch (error) {
                return reject(error);
            }
        })
    }

    /**
   * Rate submission by id.
   * @method
   * @name rateSubmissionById
   * @param {String} [submissionId = ""] -submission id.
   * @returns {JSON} - message
   */

    static rateSubmissionById(submissionId = "") {
        return new Promise(async (resolve, reject) => {
            try {

                let emailRecipients = (process.env.SUBMISSION_RATING_DEFAULT_EMAIL_RECIPIENTS && process.env.SUBMISSION_RATING_DEFAULT_EMAIL_RECIPIENTS != "") ? process.env.SUBMISSION_RATING_DEFAULT_EMAIL_RECIPIENTS : "";

                if (submissionId == "") {
                    throw new Error(messageConstants.apiResponses.OBSERVATION_SUBMISSION_ID_NOT_FOUND);
                }

                let submissionDocument = await database.models.observationSubmissions.findOne(
                    {_id : ObjectId(submissionId)},
                    { "answers": 1, "criteria": 1, "evidencesStatus": 1, "entityInformation": 1, "entityProfile": 1, "solutionExternalId": 1, "programExternalId": 1 }
                ).lean();
        
                if (!submissionDocument._id) {
                    throw new Error(messageConstants.apiResponses.OBSERVATION_SUBMISSSION_NOT_FOUND);
                }

                let solutionDocument = await database.models.solutions.findOne({
                    externalId: submissionDocument.solutionExternalId,
                    type : "observation",
                    scoringSystem : "pointsBasedScoring"
                }, { themes: 1, levelToScoreMapping: 1, scoringSystem : 1, flattenedThemes : 1, sendSubmissionRatingEmailsTo : 1}).lean();

                if (!solutionDocument) {
                    throw new Error(messageConstants.apiResponses.SOLUTION_NOT_FOUND);
                }

                if(solutionDocument.sendSubmissionRatingEmailsTo && solutionDocument.sendSubmissionRatingEmailsTo != "") {
                    emailRecipients = solutionDocument.sendSubmissionRatingEmailsTo;
                }

                submissionDocument.submissionCollection = "observationSubmissions";
                submissionDocument.scoringSystem = "pointsBasedScoring";

                let allCriteriaInSolution = new Array;
                let allQuestionIdInSolution = new Array;
                let solutionQuestions = new Array;

                allCriteriaInSolution = gen.utils.getCriteriaIds(solutionDocument.themes);

                if(allCriteriaInSolution.length > 0) {
                
                    submissionDocument.themes = solutionDocument.flattenedThemes;

                    let allCriteriaDocument = await criteriaHelper.criteriaDocument({
                        _id : {
                            $in : allCriteriaInSolution
                        }
                    }, [
                        "evidences"
                    ]);

                    allQuestionIdInSolution = gen.utils.getAllQuestionId(allCriteriaDocument);
                }

                if(allQuestionIdInSolution.length > 0) {

                    solutionQuestions = await questionsHelper.questionDocument({
                        _id : {
                        $in : allQuestionIdInSolution
                        },
                        responseType : {
                        $in : [
                            "radio",
                            "multiselect",
                            "slider"
                        ]
                        }
                    }, [
                        "weightage",
                        "options",
                        "sliderOptions",
                        "responseType"
                    ]);

                }

                if(solutionQuestions.length > 0) {
                submissionDocument.questionDocuments = {};
                solutionQuestions.forEach(question => {
                    submissionDocument.questionDocuments[question._id.toString()] = {
                    _id : question._id,
                    weightage : question.weightage
                    };
                    let questionMaxScore = 0;
                    if(question.options && question.options.length > 0) {
                    if(question.responseType != "multiselect") {
                        questionMaxScore = _.maxBy(question.options, 'score').score;
                    }
                    question.options.forEach(option => {
                        if(question.responseType == "multiselect") {
                        questionMaxScore += option.score;
                        }
                        (option.score && option.score > 0) ? submissionDocument.questionDocuments[question._id.toString()][`${option.value}-score`] = option.score : "";
                    })
                    }
                    if(question.sliderOptions && question.sliderOptions.length > 0) {
                    questionMaxScore = _.maxBy(question.sliderOptions, 'score').score;
                    submissionDocument.questionDocuments[question._id.toString()].sliderOptions = question.sliderOptions;
                    }
                    submissionDocument.questionDocuments[question._id.toString()].maxScore = questionMaxScore;
                })
                }

                let resultingArray = await submissionsHelper.rateEntities([submissionDocument], "singleRateApi");

                if(resultingArray.result.runUpdateQuery) {
                    await database.models.observationSubmissions.updateOne(
                        {
                            _id: ObjectId(submissionId)
                        },
                        {
                            status: "completed",
                            completedDate: new Date()
                        }
                    );
                    await this.pushCompletedObservationSubmissionForReporting(submissionId);
                    emailClient.pushMailToEmailService(emailRecipients,messageConstants.apiResponses.OBSERVATION_AUTO_RATING_SUCCESS+submissionId,JSON.stringify(resultingArray));
                    return resolve(messageConstants.apiResponses.OBSERVATION_RATING);
                } else {
                    emailClient.pushMailToEmailService(emailRecipients,OBSERVATION_AUTO_RATING_FAILED+submissionId,JSON.stringify(resultingArray));
                    return resolve(messageConstants.apiResponses.OBSERVATION_RATING);
                }

            } catch (error) {
                emailClient.pushMailToEmailService(emailRecipients,OBSERVATION_AUTO_RATING_FAILED+submissionId,error.message);
                return reject(error);
            }
        })
    }

};


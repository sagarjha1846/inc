const mongoose = require("mongoose")

const schema = mongoose.Schema;

const studentSchema = new schema({
  studentName: { type: String, required: true },
  fatherName: { type: String, required: true },
  dob: { type: Date, required: true },
  gender: { type: String, required: true },
  course: { type: Date, required: true },
  mobileNumber: { type: Number, required: true },
  email: { type: String, required: true },
  address: { type: String, required: true },
});

const Student = mongoose.model("StudentDB",studentSchema)

module.exports=Student;